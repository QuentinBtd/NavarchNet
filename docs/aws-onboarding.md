# AWS onboarding design and verification boundary

AWS is the first intended live provider, but this preview DOES NOT implement role verification, live discovery, adoption, provisioning or AWS mutation. Account registration explicitly rejects `aws`. Do not supply controller/target AWS credentials yet. No AWS API call, paid resource, live connectivity test or cleanup was performed during bootstrap.

## Required implementation before enabling AWS

Use the official AWS SDK's standard credential chain for the controller (environment/shared config/web identity/container/instance role according to the SDK's documented chain), then STS AssumeRole for each explicitly registered target account role. Temporary sessions must refresh; do not store permanent access keys per account. Evaluate no chain at startup while the provider is disabled. Role onboarding must verify GetCallerIdentity/account/role identity and explicit capability checks before reporting verified access. Bound session duration, attach operator/operation attribution, and handle expired sessions with refresh before idempotent retries.

Target role trust must name the specific controller principal, not a wildcard AWS principal. For third-party/confused-deputy arrangements, require a per-onboarding ExternalId and match it with `sts:ExternalId`; do not treat ExternalId as a password or publish account-specific values. Use SourceIdentity/session tags where the trust arrangement permits them and retain CloudTrail attribution. The role assumption trust and the caller's `sts:AssumeRole` permission are separate requirements.

Least-privilege discovery needs the relevant EC2 Describe APIs for VPCs/subnets/route tables, AZ IDs, TGWs/attachments/route tables/associations/propagations/routes, NAT gateways/EIPs/IGWs and relevant RAM shares/resources/principals/invitations. Many EC2 Describe APIs require Resource `*`; scope roles and permitted regions through appropriate conditions and explicit account registration. Do not invent resource-level ARN support where an action does not support it. Consult current IAM service authorization references before producing a deployable policy.

A live mutation policy must be derived from the exact reviewed action set and ownership tags/resource ARNs: attachment create/accept, TGW route table association/propagation/route operations, explicitly owned VPC routes, NAT/EIP/VPC/IGW/subnet resources and RAM operations as required. Do not hand operators an unvalidated `ec2:*`/`ram:*` policy. Deployment-ready trust/IAM JSON, SDK pagination and discovery implementation remain open acceptance criteria, not an implicit permission grant in this document.

## Two accounts, two administrative boundaries

The network account owns the regional TGW, its route tables/associations/propagations and egress infrastructure. Application accounts create/manage their VPC attachments and selected owned VPC routes. A shared-TGW consumer cannot administer the owner's TGW route tables. Shared-subnet participants are not VPC owners; unsupported ownership/topology must be rejected.

AWS RAM sharing within an enabled AWS Organization has different invitation behavior from standalone-account sharing. Discover the actual share and invitation state. Explicitly surface pending invitations/attachment acceptance and require the appropriate account role for each action; do not blindly auto-accept unrelated invitations. Map zones by AZ ID across accounts, never AZ name.

## Route and ownership acceptance

A usable live plan must include individual managed resources, exact forward and return route destinations, resource readiness and owner-role prerequisites. Disable unintended TGW default association/propagation and verify existing manual propagations and more-specific routes. Reject overlap, unsupported attachments, conflicting unmanaged defaults, unsupported NAT mode, unsupported AZs and unknown ownership. Existing private-destination routes and CIDR specificity can invalidate an isolation claim even when a default route exists.

Adoption must identify exact resource IDs, owner account, routes permitted to change, existing traffic impact and excluded resources. A tag alone is not blanket authorization to replace every route. Do not destroy old connectivity before replacement prerequisites are ready. Never call an AWS sequence atomic; retain partial/ambiguous outcomes and observe before retries. Real AWS external-effect stale-worker safety needs dedicated implementation and tests beyond transactional fake effects.

Use zonal public managed NAT first, explicitly distinguished from current regional NAT availability mode (ADR 0002). IPv4 only. NAT64/IPv6 and cross-region fallback are unsupported. Show resource state, calculated paths and actual probes separately; no untested path is healthy.

## Cost and future NAT instances

Estimate current regional prices and expected traffic for managed NAT hours/data processing, TGW attachment hours/data processing, public IPv4 addresses, relevant AZ/inter-region/Internet transfers and any compute/probes. Do not claim a fixed saving from centralization; extra TGW processing can reverse a NAT-count saving.

Evaluate fck-nat later rather than building a new NAT engine. ENI/EIP identity, instance bandwidth/packet limits, OS maintenance, availability replacement, stateful connection reset and cross-AZ/inter-region costs must be measured. Preserving an EIP does not preserve connection state. No NAT instance or tunnel/BGP overlay is deployed in V1 bootstrap.
