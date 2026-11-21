// Look up the existing network resources (VPC, subnets, security group) by name.

import { DescribeSecurityGroupsCommand, DescribeSubnetsCommand, DescribeVpcsCommand, EC2Client } from "@aws-sdk/client-ec2";

import { config } from "./config.js";

const tagName = (tags) => tags?.find((t) => t.Key === "Name")?.Value ?? "";

export async function discoverNetwork() {
  const ec2 = new EC2Client({ region: config.region });
  const { Vpcs } = await ec2.send(new DescribeVpcsCommand({
    Filters: [{ Name: "tag:Name", Values: [config.network.vpcName] }],
  }));
  const vpcId = Vpcs[0]?.VpcId;
  if (!vpcId) throw new Error(`VPC ${config.network.vpcName} not found`);

  const { Subnets } = await ec2.send(new DescribeSubnetsCommand({ Filters: [{ Name: "vpc-id", Values: [vpcId] }] }));
  const byPrefix = (prefix) => Subnets.filter((s) => tagName(s.Tags).startsWith(prefix)).map((s) => s.SubnetId);

  const { SecurityGroups } = await ec2.send(new DescribeSecurityGroupsCommand({
    Filters: [{ Name: "group-name", Values: [config.network.securityGroupName] }, { Name: "vpc-id", Values: [vpcId] }],
  }));

  return {
    vpcId,
    publicSubnetIds: byPrefix(config.network.subnetNamePrefix),
    privateSubnetIds: byPrefix(config.network.privateSubnetNamePrefix),
    securityGroupId: SecurityGroups[0]?.GroupId,
  };
}
