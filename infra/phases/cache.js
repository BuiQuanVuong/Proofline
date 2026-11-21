// Phase 5: in-memory cache: ElastiCache for Valkey,
// reachable only by the runners in the private subnets.
//
// Constraints that shape it (when the deployment reuses a shared security group):
// - the shared security group admits only some ports (3000-3010 among them,
//   not 6379), so Valkey listens on 3001;
// - it admits those ports from anywhere, so the network can't be relied on:
//   in-transit encryption is required and clients need an auth token, kept in
//   Secrets Manager (the task role may read it, per the role probe);
// - the existing cache subnet group covers the private subnets;
// - node-based, not serverless: a serverless cache only listens on 6379.
// It's the system's one always-on resource (cost section).

import {
  CreateReplicationGroupCommand, DeleteReplicationGroupCommand, DescribeReplicationGroupsCommand, ElastiCacheClient,
} from "@aws-sdk/client-elasticache";
import {
  CreateSecretCommand, DeleteSecretCommand, GetSecretValueCommand, SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { randomBytes } from "node:crypto";

import { config, name, tagList } from "../config.js";
import { isError, log } from "../lib/log.js";
import { discoverNetwork } from "../network.js";

const { region } = config;

export const CACHE = {
  id: name("cache"),
  secret: name("cache-auth"),
  nodeType: "cache.t4g.micro",
  port: 3001,
};

async function authToken() {
  const sm = new SecretsManagerClient({ region });
  try {
    // 48 hex characters: within Valkey's 16-128 limit, and none of the characters it forbids.
    await sm.send(new CreateSecretCommand({
      Name: CACHE.secret, SecretString: randomBytes(24).toString("hex"), Tags: tagList(),
      Description: "Proofline: Valkey AUTH token for the runners",
    }));
    log("created", `secret ${CACHE.secret}`);
  } catch (err) {
    if (!isError(err, "ResourceExistsException")) throw err;
    log("exists", `secret ${CACHE.secret}`);
  }
  const { SecretString } = await sm.send(new GetSecretValueCommand({ SecretId: CACHE.secret }));
  return SecretString;
}

/** The replication group's status and primary endpoint, or null if it doesn't exist. */
export async function describeCache() {
  try {
    const { ReplicationGroups } = await new ElastiCacheClient({ region }).send(
      new DescribeReplicationGroupsCommand({ ReplicationGroupId: CACHE.id }));
    const g = ReplicationGroups[0];
    const endpoint = g.NodeGroups?.[0]?.PrimaryEndpoint;
    return { status: g.Status, host: endpoint?.Address ?? null, port: endpoint?.Port ?? CACHE.port, arn: g.ARN };
  } catch (err) {
    if (isError(err, "ReplicationGroupNotFoundFault")) return null;
    throw err;
  }
}

export async function deployCache() {
  const token = await authToken();
  const net = await discoverNetwork();
  try {
    await new ElastiCacheClient({ region }).send(new CreateReplicationGroupCommand({
      ReplicationGroupId: CACHE.id,
      ReplicationGroupDescription: "Proofline hot result tier and single-flight locks (runners only)",
      Engine: "valkey",
      CacheNodeType: CACHE.nodeType,
      NumCacheClusters: 1,
      AutomaticFailoverEnabled: false,
      Port: CACHE.port,
      CacheSubnetGroupName: config.network.cacheSubnetGroup,
      SecurityGroupIds: [net.securityGroupId],
      TransitEncryptionEnabled: true,
      AtRestEncryptionEnabled: true,
      AuthToken: token,
      SnapshotRetentionLimit: 0, // everything in it can be rebuilt from DynamoDB
      Tags: tagList(),
    }));
    log("created", `Valkey ${CACHE.id}`, `${CACHE.nodeType}, port ${CACHE.port}, TLS + auth token, ${config.network.cacheSubnetGroup}`);
  } catch (err) {
    if (!isError(err, "ReplicationGroupAlreadyExistsFault")) throw err;
    log("exists", `Valkey ${CACHE.id}`);
  }

  // Creation takes ~10-15 minutes. Wait, so phase 3 can be run straight after.
  const deadline = Date.now() + 25 * 60_000;
  let last = "";
  for (;;) {
    const c = await describeCache();
    if (c.status !== last) log("status", `Valkey ${CACHE.id}`, c.status);
    last = c.status;
    if (c.status === "available") return { endpoint: `${c.host}:${c.port}`, secret: CACHE.secret, next: "node infra/deploy.js --phase=3" };
    if (Date.now() > deadline) return { status: c.status, note: "still creating; re-run this phase to keep waiting" };
    await new Promise((r) => setTimeout(r, 30_000));
  }
}

export async function teardownCache({ apply }) {
  const step = async (label, fn) => {
    if (!apply) return log("would", `delete ${label}`);
    try {
      await fn();
      log("deleted", label);
    } catch (err) {
      if (isError(err, "ReplicationGroupNotFoundFault", "ResourceNotFoundException")) log("absent", label);
      else log("FAILED", label, `${err.name}: ${err.message}`);
    }
  };
  await step(`Valkey ${CACHE.id}`, () => new ElastiCacheClient({ region }).send(new DeleteReplicationGroupCommand({
    ReplicationGroupId: CACHE.id, RetainPrimaryCluster: false,
  })));
  await step(`secret ${CACHE.secret}`, () => new SecretsManagerClient({ region }).send(new DeleteSecretCommand({
    SecretId: CACHE.secret, ForceDeleteWithoutRecovery: true,
  })));
}
