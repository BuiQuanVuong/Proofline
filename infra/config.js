// Deployment configuration: resource names, tags, region, and the existing
// account resources the deployment builds on (IAM roles, VPC, API Gateway,
// Cognito user pool).
//
// Values are resolved in this order (later wins):
//   1. the defaults below;
//   2. infra/config.local.json (git-ignored; see infra/config.example.json);
//   3. environment variables (PROOFLINE_*, AWS_ACCOUNT_ID, AWS_REGION).

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const localFile = path.join(here, "config.local.json");

const defaults = {
  accountId: "",
  region: "ap-southeast-2",
  // Every resource is named `<prefix>-<component>`.
  prefix: "proofline",
  // Parameter Store path for the names the services resolve at run time.
  paramPrefix: "/proofline",
  // Applied to every resource on creation.
  tags: { project: "proofline" },
  // Pre-existing IAM roles. The deployment uses these rather than creating
  // roles, so it also works in accounts where role creation is restricted.
  roles: {
    lambda: "proofline-lambda",
    task: "proofline-task",
    execution: "proofline-task-execution",
    scheduler: "proofline-scheduler",
  },
  // Pre-existing networking, looked up by name.
  network: {
    vpcName: "proofline-vpc",
    subnetNamePrefix: "proofline-public",
    privateSubnetNamePrefix: "proofline-private",
    securityGroupName: "proofline-sg",
    cacheSubnetGroup: "proofline-private-subnets",
  },
  // An existing HTTP API and Cognito user pool. Proofline adds its routes under
  // `apiPrefix` and authorises them with the pool's ID tokens.
  apiId: "",
  apiPrefix: "/v1",
  cognitoUserPoolId: "",
};

const local = existsSync(localFile) ? JSON.parse(readFileSync(localFile, "utf8")) : {};
const env = process.env;
const fromEnv = Object.fromEntries(Object.entries({
  accountId: env.AWS_ACCOUNT_ID,
  region: env.PROOFLINE_REGION ?? env.AWS_REGION,
  prefix: env.PROOFLINE_PREFIX,
  paramPrefix: env.PROOFLINE_PARAM_PREFIX,
  apiId: env.PROOFLINE_API_ID,
  apiPrefix: env.PROOFLINE_API_PREFIX,
  cognitoUserPoolId: env.PROOFLINE_USER_POOL_ID,
}).filter(([, v]) => v));

export const config = {
  ...defaults,
  ...local,
  ...fromEnv,
  tags: local.tags ?? defaults.tags,
  roles: { ...defaults.roles, ...local.roles },
  network: { ...defaults.network, ...local.network },
};

const missing = ["accountId", "apiId", "cognitoUserPoolId"].filter((k) => !config[k]);
if (missing.length) {
  throw new Error(`infra/config: missing ${missing.join(", ")}. ` +
    "Set them in infra/config.local.json (copy infra/config.example.json) or through the environment.");
}

/** Resource name for a Proofline component, e.g. name("main") -> "proofline-main". */
export const name = (component) => `${config.prefix}-${component}`;

export const roleArn = (role) => `arn:aws:iam::${config.accountId}:role/${config.roles[role]}`;

/** Tags in the two shapes AWS APIs use. */
export const tagList = (keyName = "Key", valueName = "Value") =>
  Object.entries(config.tags).map(([k, v]) => ({ [keyName]: k, [valueName]: v }));
export const tagMap = () => ({ ...config.tags });
