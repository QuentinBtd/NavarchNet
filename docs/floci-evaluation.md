# Floci evaluation: optional API compatibility, not AWS acceptance

Evaluated October 19, 2026. No Floci test is added to automatic CI or the ordinary local gate. The deterministic fake/replay fault tests and true AWS acceptance remain distinct.

## Exact pin

- Upstream release `2.3.0`, published October 15, 2026; source commit `ee15f502bfc017861b67b076b82e1ccd032c7129`.
- OCI index `floci/floci@sha256:e0b292df4dc9559b7b1bf4f51bdda4bb8e269276236438cd03cae661260ea8a9`.
- Selected Linux amd64 manifest `sha256:09b72c45f333019adecb302e79c6b746e290135f528016c8514618bc7ab02344`; manifest/config/layer hashes were checked and the image source-revision label matches the pinned checkout.
- Extracted native executable SHA-256 `bb4be0860e3b2394c1822ed98450f9432d8054d867e072b5e66901b93adfa514`. No image build, Java installation, Docker daemon installation or Docker socket mount occurred.

## Source dispatch coverage, not executed operations

The pinned dispatchers expose handlers for all 17 distinct current NavarchNet operations (the initial 15-operation inventory is preserved separately; two scoped TGW reads were subsequently added):

| Service | Current operations found |
| --- | --- |
| EC2 | DescribeVpcs, DescribeSubnets, DescribeRouteTables, DescribeTransitGateways, DescribeTransitGatewayVpcAttachments, DescribeNatGateways, DescribeInternetGateways, DescribeAddresses, DescribeTransitGatewayRouteTables, GetTransitGatewayRouteTableAssociations, GetTransitGatewayRouteTablePropagations |
| STS | AssumeRole, GetCallerIdentity |
| RAM | GetResourceShares, GetResourceShareInvitations, ListResources, ListPrincipals |

The mission's machine-readable inventory has 56 current/future operation rows with exact pinned source file/line references and `runtime_exercised:false`. A dispatch case/path is not proof that our signed clients interoperate or that every parameter, response field, pagination behavior and authorization rule matches AWS.

The pinned EC2 documentation's lines 440–441 say TGW attachments and route-table actions are unimplemented, but subsequent sections list them. `Ec2QueryHandler.java` lines 127–168 actually dispatch attachment, route-table association, propagation and static-route/search actions. The old paragraph is stale relative to this source; those handlers were not invoked during this evaluation.

Important gaps for the future egress implementation:

- `AcceptTransitGatewayVpcAttachment`, `RejectTransitGatewayVpcAttachment`, `ReplaceRouteTableAssociation` and RAM `GetResourceShareAssociations` have no matching dispatch in the inspected source.
- `CreateRoute` does not read a `TransitGatewayId` parameter, and `ReplaceRoute` explicitly rejects it (`Ec2QueryHandler.java` lines 3799–3828 and the unsupported-target list). Handler presence therefore cannot qualify the VPC-to-TGW route changes NavarchNet needs.
- NAT operations create/describe/delete metadata records, not a forwarding data plane. TGW route records do not establish actual egress, return traffic or application-VPC isolation.
- RAM documents broad `OTHER-ACCOUNTS` visibility, invitations that do not gate resource visibility, ignored pagination and simplified permission/transition behavior. These cannot replace owner/consumer/organization semantics tests or true AWS qualification.
- STS source requires an existing IAM role even when policy enforcement is disabled. A future fixture needs explicit dummy-role setup; do not weaken NavarchNet caller validation to accept an emulator shortcut.

## Actual runtime receipt and blocker

The digest-verified native executable was launched with a 256 MiB heap, UID/GID 65534, no-new-privileges, a task-owned working directory and a deliberately constructed environment without inherited AWS configuration. Quarkus logged native Floci 2.3.0 and an actual main HTTP bind on `127.0.0.1`. The planned post-readiness `/proc` capability assertion was not reached and is not claimed as independently observed evidence.

The initial readiness checker looked for a nonexistent top-level `ready` instead of `completed.ready`. It timed out and terminated/reaped the process. That is a harness oracle failure, not evidence that Floci failed startup. No NavarchNet SDK/EC2/RAM provider operation was attempted.

Inspection also found `Ec2MetadataServer.listen(port)` starts an additional IMDS listener without an explicit loopback host. A loopback main endpoint alone is insufficient isolation. This host has no Docker/Podman, and an attempted private user/network namespace was refused with `Permission denied`. The diagnostic launcher now refuses activation unless the network namespace contains only loopback. Both previous service ports were verified closed. No global firewall/service change or socket mount was used as a workaround.

Provider-client compatibility is therefore UNEXECUTED, not passed. A future bounded run requires an already authorized isolated container/network environment, static dummy credentials, explicit endpoint injection for every client and no real AWS fallback. Reuse actual STS/RAM SDK clients and the signed EC2 adapter; retain independent fake/replay failure tests. Do not add a nominal mise task and describe it as exercised before its real client run succeeds.

## Primary references

- Pinned repository: https://github.com/floci-io/floci/tree/ee15f502bfc017861b67b076b82e1ccd032c7129
- Pinned EC2 docs: https://github.com/floci-io/floci/blob/ee15f502bfc017861b67b076b82e1ccd032c7129/docs/services/ec2.md
- Pinned RAM docs: https://github.com/floci-io/floci/blob/ee15f502bfc017861b67b076b82e1ccd032c7129/docs/services/ram.md
- Source dispatchers: `src/main/java/io/github/hectorvent/floci/services/{ec2/Ec2QueryHandler,iam/StsQueryHandler,ram/RamController}.java` at that commit.

Mission receipts are outside the checkout under `/root/.hermes/navarchnet-autonomy/probes/floci/`, particularly `coverage-2.3.0.json`, the verified OCI metadata and the preserved startup log. None establishes live AWS connectivity, IAM fidelity or production readiness.
