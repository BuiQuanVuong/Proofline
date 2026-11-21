// Phase 2: container registry for the runner image.

import {
  CreateRepositoryCommand, DeleteRepositoryCommand, DescribeImagesCommand, ECRClient, PutLifecyclePolicyCommand,
} from "@aws-sdk/client-ecr";

import { config, name, tagList } from "../config.js";
import { isError, log } from "../lib/log.js";

export const REGISTRY = {
  repository: name("runner"),
  host: `${config.accountId}.dkr.ecr.${config.region}.amazonaws.com`,
};
export const repositoryUri = () => `${REGISTRY.host}/${REGISTRY.repository}`;

/** Tagged images in the repository, newest push first. */
export async function listImages() {
  const ecr = new ECRClient({ region: config.region });
  const images = [];
  let nextToken;
  do {
    const page = await ecr.send(new DescribeImagesCommand({
      repositoryName: REGISTRY.repository, filter: { tagStatus: "TAGGED" }, nextToken,
    }));
    images.push(...page.imageDetails);
    nextToken = page.nextToken;
  } while (nextToken);
  return images
    .sort((a, b) => b.imagePushedAt - a.imagePushedAt)
    .map((d) => ({ uri: `${repositoryUri()}:${d.imageTags[0]}`, tags: d.imageTags, pushedAt: d.imagePushedAt }));
}

// Untagged layers go after a day; the newest 10 tagged images are kept for rollback.
const LIFECYCLE = {
  rules: [
    { rulePriority: 1, description: "expire untagged after 1 day",
      selection: { tagStatus: "untagged", countType: "sinceImagePushed", countUnit: "days", countNumber: 1 },
      action: { type: "expire" } },
    { rulePriority: 2, description: "keep the newest 10 images",
      selection: { tagStatus: "any", countType: "imageCountMoreThan", countNumber: 10 },
      action: { type: "expire" } },
  ],
};

export async function deployRegistry() {
  const ecr = new ECRClient({ region: config.region });
  try {
    await ecr.send(new CreateRepositoryCommand({
      repositoryName: REGISTRY.repository,
      // Immutable tags: a task definition names an exact image, so a deploy is reproducible.
      imageTagMutability: "IMMUTABLE",
      imageScanningConfiguration: { scanOnPush: true },
      encryptionConfiguration: { encryptionType: "AES256" },
      tags: tagList(),
    }));
    log("created", `ECR repository ${REGISTRY.repository}`, "immutable tags, scan on push");
  } catch (err) {
    if (!isError(err, "RepositoryAlreadyExistsException")) throw err;
    log("exists", `ECR repository ${REGISTRY.repository}`);
  }
  await ecr.send(new PutLifecyclePolicyCommand({
    repositoryName: REGISTRY.repository, lifecyclePolicyText: JSON.stringify(LIFECYCLE),
  }));
  log("ok", "  lifecycle: untagged 1 day, keep newest 10");
  return { repositoryUri: repositoryUri() };
}

export async function teardownRegistry({ apply }) {
  const label = `ECR repository ${REGISTRY.repository} (and its images)`;
  if (!apply) return log("would", `delete ${label}`);
  try {
    await new ECRClient({ region: config.region }).send(new DeleteRepositoryCommand({
      repositoryName: REGISTRY.repository, force: true,
    }));
    log("deleted", label);
  } catch (err) {
    if (isError(err, "RepositoryNotFoundException")) log("absent", label);
    else log("FAILED", label, `${err.name}: ${err.message}`);
  }
}
