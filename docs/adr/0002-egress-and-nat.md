# ADR 0002: conservative IPv4 egress and explicit NAT deployment model

Status: accepted as a design boundary; AWS execution is not implemented or verified.

Use regional egress by default, never implicit cross-region fallback. Distinguish a regional NETWORK policy from an AWS NAT gateway's `zonal` or `regional` availability mode.

The first planned AWS implementation will explicitly select zonal public managed NAT gateways, one per configured AZ, with AZ-ID mapping, selected TGW attachment subnets, same-AZ NAT routes, public-subnet IGW routes and explicit return routes from NAT subnets through the TGW. Isolation/return/NAT readiness precede spoke default-route activation. Application-spoke TGW route tables must not propagate other spokes by default. Explicit private-destination blackholes or equivalent validated policy must prevent default egress routing from accidentally becoming inter-spoke transit.

Current AWS documentation also offers regional NAT gateways, with a single NAT ID, automatic AZ expansion, no public-subnet placement and an AWS-managed NAT route table that supports TGW return routes. Expansion may take up to 60 minutes and temporarily cross AZs. This is not the same topology as the selected zonal design. Do not silently apply zonal routing assumptions to a regional NAT gateway. A future capability/model extension must discover availability mode and reject unsupported adoption rather than misconfigure return routing.

The fake planner is a coarse logical simulator, not deployable AWS route generation. It encodes attachment/isolation/return/NAT/default ordering but does not expand actual AWS route resources. It rejects IPv6, CIDR overlap, unmanaged default routes, unsupported AZs and application connectivity. Real blackhole specificity, existing propagations, existing more-specific routes, shared subnets and ownership adoption require actual discovered topology validation before live support.

NAT instances/fck-nat are future scope. They can preserve an EIP or ENI identity with explicit configuration, but instance throughput, packet rate, maintenance, replacement readiness and connection-state loss differ from managed NAT. No savings or seamless failover claim is made. A router overlay or arbitrary BGP weighting is not part of V1; VPC attachment routing is not BGP, and tunnel endpoints do not erase peering restrictions.
