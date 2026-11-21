// Read-only probe of what the target account allows and what already exists.
// Makes no changes. Run with: node infra/probe.js
//
// Each check reports OK, DENIED (the caller lacks the permission) or FAIL
// (another error). This tests the caller's own role; what the Lambda and ECS
// roles may do is checked separately by infra/role-probe.js.

import { ApplicationAutoScalingClient, DescribeScalableTargetsCommand } from "@aws-sdk/client-application-auto-scaling";
import { ApiGatewayV2Client, GetApiCommand, GetRoutesCommand } from "@aws-sdk/client-apigatewayv2";
import { CloudFrontClient, ListDistributionsCommand } from "@aws-sdk/client-cloudfront";
import { CloudWatchClient, ListDashboardsCommand } from "@aws-sdk/client-cloudwatch";
import { CognitoIdentityProviderClient, DescribeUserPoolCommand } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient, ListTablesCommand } from "@aws-sdk/client-dynamodb";
import {
  CreateSecurityGroupCommand, DescribeRouteTablesCommand, DescribeSecurityGroupsCommand, DescribeSubnetsCommand,
  DescribeVpcEndpointsCommand, DescribeVpcsCommand, EC2Client,
} from "@aws-sdk/client-ec2";
import { DescribeRepositoriesCommand, ECRClient } from "@aws-sdk/client-ecr";
import { DescribeClustersCommand, ECSClient, ListClustersCommand } from "@aws-sdk/client-ecs";
import { DescribeCacheClustersCommand, DescribeCacheSubnetGroupsCommand, DescribeServerlessCachesCommand, ElastiCacheClient } from "@aws-sdk/client-elasticache";
import { EventBridgeClient, ListEventBusesCommand } from "@aws-sdk/client-eventbridge";
import { GetRoleCommand, IAMClient } from "@aws-sdk/client-iam";
import { LambdaClient, ListFunctionsCommand } from "@aws-sdk/client-lambda";
import { ListBucketsCommand, S3Client } from "@aws-sdk/client-s3";
import { ListQueuesCommand, SQSClient } from "@aws-sdk/client-sqs";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";

import { config } from "./config.js";

const region = config.region;
const own = config.prefix.toLowerCase();
const mine = (names) => names.filter((n) => n?.toLowerCase().includes(own));
const tagName = (tags) => tags?.find((t) => t.Key === "Name")?.Value;

const ec2 = new EC2Client({ region });
const iam = new IAMClient({ region });
const discovered = {};

const checks = [
  ["identity", async () => {
    const id = await new STSClient({ region }).send(new GetCallerIdentityCommand({}));
    if (id.Account !== config.accountId) throw new Error(`wrong account ${id.Account}`);
    return id.Arn.replace(/^arn:aws:sts::\d+:assumed-role\//, "");
  }],
  ["network: VPC", async () => {
    const { Vpcs } = await ec2.send(new DescribeVpcsCommand({
      Filters: [{ Name: "tag:Name", Values: [config.network.vpcName] }],
    }));
    if (!Vpcs.length) throw new Error(`no VPC named ${config.network.vpcName}`);
    discovered.vpcId = Vpcs[0].VpcId;
    return `${discovered.vpcId} ${Vpcs[0].CidrBlock}`;
  }],
  ["network: public subnets", async () => {
    const { Subnets } = await ec2.send(new DescribeSubnetsCommand({
      Filters: [{ Name: "vpc-id", Values: [discovered.vpcId] }],
    }));
    const pub = Subnets.filter((s) => tagName(s.Tags)?.startsWith(config.network.subnetNamePrefix));
    discovered.subnetIds = pub.map((s) => s.SubnetId);
    const others = Subnets.length - pub.length;
    return `${pub.map((s) => `${tagName(s.Tags)}=${s.SubnetId}(${s.AvailabilityZone})`).join(", ")}` +
      (others ? `; ${others} other subnets: ${Subnets.filter((s) => !pub.includes(s)).map((s) => tagName(s.Tags) ?? s.SubnetId).join(", ")}` : "");
  }],
  ["network: security group", async () => {
    const { SecurityGroups } = await ec2.send(new DescribeSecurityGroupsCommand({
      Filters: [{ Name: "group-name", Values: [config.network.securityGroupName] }],
    }));
    if (!SecurityGroups.length) throw new Error(`no ${config.network.securityGroupName}`);
    const sg = SecurityGroups[0];
    discovered.securityGroupId = sg.GroupId;
    const sources = (r) => [
      ...r.IpRanges.map((x) => x.CidrIp), ...r.Ipv6Ranges.map((x) => x.CidrIpv6),
      ...r.UserIdGroupPairs.map((x) => (x.GroupId === sg.GroupId ? "self" : x.GroupId)),
      ...r.PrefixListIds.map((x) => x.PrefixListId),
    ].join("|");
    const fmt = (rules) => rules.map((r) =>
      `${r.IpProtocol === "-1" ? "all" : `${r.IpProtocol}:${r.FromPort}-${r.ToPort}`}<${sources(r)}`).join(" ");
    return `${sg.GroupId}\n            in  ${fmt(sg.IpPermissions)}\n            out ${fmt(sg.IpPermissionsEgress)}`;
  }],
  ["network: route tables", async () => {
    const { RouteTables } = await ec2.send(new DescribeRouteTablesCommand({
      Filters: [{ Name: "vpc-id", Values: [discovered.vpcId] }],
    }));
    const { Subnets } = await ec2.send(new DescribeSubnetsCommand({
      Filters: [{ Name: "vpc-id", Values: [discovered.vpcId] }],
    }));
    const subnetName = Object.fromEntries(Subnets.map((s) => [s.SubnetId, tagName(s.Tags) ?? s.SubnetId]));
    return "\n" + RouteTables.map((rt) => {
      const attached = rt.Associations.map((a) => (a.Main ? "main" : subnetName[a.SubnetId] ?? a.SubnetId)).join(",");
      const routes = rt.Routes.map((r) =>
        `${r.DestinationCidrBlock ?? r.DestinationPrefixListId}->${r.GatewayId ?? r.NatGatewayId ?? r.TransitGatewayId ?? r.VpcPeeringConnectionId ?? r.NetworkInterfaceId ?? "?"}`).join(" ");
      return `            ${rt.RouteTableId} [${attached}] ${routes}`;
    }).join("\n");
  }],
  ["network: VPC endpoints", async () => {
    const { VpcEndpoints } = await ec2.send(new DescribeVpcEndpointsCommand({
      Filters: [{ Name: "vpc-id", Values: [discovered.vpcId] }],
    }));
    return VpcEndpoints.map((e) => `${e.ServiceName.split(".").pop()}(${e.VpcEndpointType}, ${e.State})`).join(", ") || "none";
  }],
  ["network: may create security group (dry run)", async () => {
    try {
      await ec2.send(new CreateSecurityGroupCommand({
        DryRun: true, GroupName: `${config.prefix}-probe`, Description: "dry run only",
        VpcId: discovered.vpcId,
        TagSpecifications: [{ ResourceType: "security-group", Tags: Object.entries(config.tags).map(([Key, Value]) => ({ Key, Value })) }],
      }));
    } catch (err) {
      if (err.name === "DryRunOperation") return "yes (would succeed)";
      throw err;
    }
    throw new Error("dry run unexpectedly executed");
  }],
  ...Object.entries(config.roles).map(([key, role]) => [`iam: role ${key}`, async () => {
    const { Role } = await iam.send(new GetRoleCommand({ RoleName: role }));
    return Role.Arn;
  }]),
  ["ecs: clusters", async () => {
    const ecs = new ECSClient({ region });
    const { clusterArns } = await ecs.send(new ListClustersCommand({}));
    const own = mine(clusterArns);
    if (own.length) {
      const { clusters } = await ecs.send(new DescribeClustersCommand({ clusters: own }));
      return clusters.map((c) => `${c.clusterName} (${c.status}, services=${c.activeServicesCount}, tasks=${c.runningTasksCount})`).join(", ");
    }
    return `none of ${clusterArns.length} visible clusters are ours`;
  }],
  ["ecs: service auto scaling API", async () => {
    const { ScalableTargets } = await new ApplicationAutoScalingClient({ region })
      .send(new DescribeScalableTargetsCommand({ ServiceNamespace: "ecs" }));
    return `readable; ${ScalableTargets.length} scalable targets in account`;
  }],
  ["ecr: repositories", async () => {
    const { repositories } = await new ECRClient({ region }).send(new DescribeRepositoriesCommand({}));
    return mine(repositories.map((r) => r.repositoryName)).join(", ") || "none ours";
  }],
  ["sqs: queues", async () => {
    const { QueueUrls = [] } = await new SQSClient({ region }).send(new ListQueuesCommand({ QueueNamePrefix: config.prefix }));
    return QueueUrls.map((u) => u.split("/").pop()).join(", ") || "none ours";
  }],
  ["dynamodb: tables", async () => {
    const db = new DynamoDBClient({ region });
    const names = [];
    let start;
    do {
      const page = await db.send(new ListTablesCommand({ ExclusiveStartTableName: start }));
      names.push(...page.TableNames);
      start = page.LastEvaluatedTableName;
    } while (start);
    const own = mine(names);
    return `${own.length} ours: ${own.join(", ")}`;
  }],
  ["s3: buckets", async () => {
    const { Buckets } = await new S3Client({ region }).send(new ListBucketsCommand({}));
    return mine(Buckets.map((b) => b.Name)).join(", ") || "none ours";
  }],
  ["lambda: functions", async () => {
    const lambda = new LambdaClient({ region });
    const own = [];
    let Marker;
    do {
      const page = await lambda.send(new ListFunctionsCommand({ Marker }));
      own.push(...page.Functions.filter((f) => f.FunctionName.includes(config.prefix)));
      Marker = page.NextMarker;
    } while (Marker);
    return own.map((f) => `${f.FunctionName}(${f.Runtime})`).join(", ") || "none ours";
  }],
  ["eventbridge: buses", async () => {
    const { EventBuses } = await new EventBridgeClient({ region }).send(new ListEventBusesCommand({}));
    return `readable; ${EventBuses.length} buses, ours: ${mine(EventBuses.map((b) => b.Name)).join(", ") || "none"}`;
  }],
  ["elasticache: clusters", async () => {
    const { CacheClusters } = await new ElastiCacheClient({ region }).send(new DescribeCacheClustersCommand({}));
    const own = CacheClusters.filter((c) => c.CacheClusterId.includes(config.prefix));
    const engines = [...new Set(CacheClusters.map((c) => `${c.Engine}/${c.CacheNodeType}`))].join(", ");
    return `${CacheClusters.length} in account (${engines || "none"}); ours: ${own.map((c) => c.CacheClusterId).join(", ") || "none"}`;
  }],
  ["elasticache: serverless caches", async () => {
    const { ServerlessCaches = [] } = await new ElastiCacheClient({ region }).send(new DescribeServerlessCachesCommand({}));
    return `readable; ${ServerlessCaches.length} in account`;
  }],
  ["elasticache: subnet groups", async () => {
    const groups = [];
    let Marker;
    do {
      const page = await new ElastiCacheClient({ region }).send(new DescribeCacheSubnetGroupsCommand({ Marker }));
      groups.push(...page.CacheSubnetGroups);
      Marker = page.Marker;
    } while (Marker);
    // Show only the configured shared group and our own.
    const shared = groups.filter((g) => g.CacheSubnetGroupName === config.network.cacheSubnetGroup ||
      g.CacheSubnetGroupName.includes(config.prefix));
    const { Subnets } = await ec2.send(new DescribeSubnetsCommand({ Filters: [{ Name: "vpc-id", Values: [discovered.vpcId] }] }));
    const subnetName = Object.fromEntries(Subnets.map((s) => [s.SubnetId, tagName(s.Tags) ?? s.SubnetId]));
    return `${groups.length} in account; shared/ours:\n` + shared.map((g) =>
      `            ${g.CacheSubnetGroupName}: ${g.Subnets.map((s) => subnetName[s.SubnetIdentifier] ?? s.SubnetIdentifier).join(", ")}`).join("\n");
  }],
  ["cloudfront: distributions", async () => {
    const { DistributionList } = await new CloudFrontClient({ region: "us-east-1" }).send(new ListDistributionsCommand({}));
    return `readable; ${DistributionList?.Quantity ?? 0} in account`;
  }],
  ["cloudwatch: dashboards", async () => {
    const { DashboardEntries } = await new CloudWatchClient({ region }).send(new ListDashboardsCommand({}));
    return `readable; ours: ${mine(DashboardEntries.map((d) => d.DashboardName)).join(", ") || "none"}`;
  }],
  ["api gateway: reused API", async () => {
    const api = new ApiGatewayV2Client({ region });
    const a = await api.send(new GetApiCommand({ ApiId: config.apiId }));
    const { Items } = await api.send(new GetRoutesCommand({ ApiId: config.apiId, MaxResults: "500" }));
    const ours = Items.filter((r) => r.RouteKey.includes(config.apiPrefix + "/"));
    return `${a.Name} (${a.ProtocolType}) ${Items.length} routes, ${ours.length} under ${config.apiPrefix}`;
  }],
  ["cognito: reused user pool", async () => {
    const { UserPool } = await new CognitoIdentityProviderClient({ region })
      .send(new DescribeUserPoolCommand({ UserPoolId: config.cognitoUserPoolId }));
    return `${UserPool.Name}, ~${UserPool.EstimatedNumberOfUsers} users`;
  }],
];

const DENIED = /AccessDenied|UnauthorizedOperation|not authorized|AuthorizationError/i;
const pad = Math.max(...checks.map(([n]) => n.length));
let denied = 0;
let failed = 0;

console.log(`Proofline probe: ${config.prefix} @ ${config.accountId} / ${region}  (read-only)\n`);
for (const [label, fn] of checks) {
  try {
    console.log(`  OK      ${label.padEnd(pad)}  ${await fn()}`);
  } catch (err) {
    const isDenied = DENIED.test(`${err.name} ${err.message}`);
    isDenied ? denied++ : failed++;
    const msg = (err.message ?? String(err)).split("\n")[0].slice(0, 160);
    console.log(`  ${isDenied ? "DENIED" : "FAIL  "}  ${label.padEnd(pad)}  ${err.name}: ${msg}`);
  }
}
console.log(`\n${checks.length - denied - failed} ok, ${denied} denied, ${failed} failed`);
console.log("discovered:", JSON.stringify(discovered));
