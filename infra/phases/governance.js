// Phase 6: access control. Cognito group `<prefix>-admins` in the existing
// user pool. The api Lambda (PROOFLINE_ADMIN_GROUP) lets its members read any
// job; only a job's owner can start it. `--admin=<email>` adds that user to
// the group. Cognito groups can't be tagged and have no ARN.

import {
  AdminAddUserToGroupCommand, CognitoIdentityProviderClient, CreateGroupCommand, DeleteGroupCommand, ListUsersCommand,
  UpdateGroupCommand,
} from "@aws-sdk/client-cognito-identity-provider";

import { config, name } from "../config.js";
import { isError, log } from "../lib/log.js";

const { region } = config;

export const GOVERNANCE = {
  adminGroup: name("admins"),
};

const cognito = () => new CognitoIdentityProviderClient({ region });

async function deployAdminGroup() {
  const group = {
    UserPoolId: config.cognitoUserPoolId, GroupName: GOVERNANCE.adminGroup,
    Description: "Proofline admins: may read every user's verification jobs (read-only)",
  };
  try {
    await cognito().send(new CreateGroupCommand(group));
    log("created", `Cognito group ${GOVERNANCE.adminGroup}`);
  } catch (err) {
    if (!isError(err, "GroupExistsException")) throw err;
    await cognito().send(new UpdateGroupCommand(group));
    log("exists", `Cognito group ${GOVERNANCE.adminGroup}`, "description updated");
  }
}

/** Adds the user with this email to the admin group. */
async function addAdmin(email) {
  const { Users = [] } = await cognito().send(new ListUsersCommand({
    UserPoolId: config.cognitoUserPoolId, Filter: `email = "${email.replace(/"/g, "")}"`, Limit: 2,
  }));
  if (Users.length !== 1) throw new Error(`expected one user with email ${email}, found ${Users.length}`);
  await cognito().send(new AdminAddUserToGroupCommand({
    UserPoolId: config.cognitoUserPoolId, Username: Users[0].Username, GroupName: GOVERNANCE.adminGroup,
  }));
  log("added", `${email} to ${GOVERNANCE.adminGroup}`, "sign in again so the new ID token carries the group");
}

export async function deployGovernance() {
  await deployAdminGroup();
  const admin = process.argv.find((a) => a.startsWith("--admin="))?.split("=")[1];
  if (admin) await addAdmin(admin);
  return {
    adminGroup: GOVERNANCE.adminGroup,
    next: "node infra/deploy.js --phase=4  (redeploys the api Lambda with PROOFLINE_ADMIN_GROUP; once is enough)",
  };
}

export async function teardownGovernance({ apply }) {
  const label = `Cognito group ${GOVERNANCE.adminGroup}`;
  if (!apply) return log("would", `delete ${label}`);
  // The user pool is shared with other applications and is kept; only Proofline's group goes.
  try {
    await cognito().send(new DeleteGroupCommand({ UserPoolId: config.cognitoUserPoolId, GroupName: GOVERNANCE.adminGroup }));
    log("deleted", label);
  } catch (err) {
    if (isError(err, "ResourceNotFoundException")) log("absent", label);
    else log("FAILED", label, `${err.name}: ${err.message}`);
  }
}
