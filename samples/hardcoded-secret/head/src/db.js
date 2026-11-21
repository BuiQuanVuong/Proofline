const dbPassword = "hunter2-production";

export function tableName(entity) {
  return `app_${entity}`;
}

export function connectionString(host) {
  return `postgres://app:${dbPassword}@${host}/shop`;
}
