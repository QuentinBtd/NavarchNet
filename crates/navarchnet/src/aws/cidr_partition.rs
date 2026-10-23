//! Private bounded membership transitions. Predicates remain caller-owned and opaque.
use super::{
    observation::{AwsTopology, ResourceKind},
    source_handoff_cidr_coverage::{CutEdge, SourceHandoffCidrError, check, checked},
    vpc_lookup,
};
use ipnet::IpNet;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
type Result<T> = std::result::Result<T, SourceHandoffCidrError>;
pub(crate) fn ordinal(ip: IpAddr) -> u128 {
    match ip {
        IpAddr::V4(v) => u128::from(u32::from(v)),
        IpAddr::V6(v) => u128::from(v),
    }
}
pub(crate) fn address(value: u128, v4: bool) -> Result<String> {
    Ok(if v4 {
        Ipv4Addr::from(
            u32::try_from(value).map_err(|_| SourceHandoffCidrError::PartitionProofUnavailable)?,
        )
        .to_string()
    } else {
        Ipv6Addr::from(value).to_string()
    })
}
pub(crate) struct Transitions<P> {
    net: IpNet,
    raw: Vec<(u128, usize, P, CutEdge, bool)>,
    raw_limit: usize,
    cell_limit: usize,
}
impl<P: Copy> Transitions<P> {
    pub(crate) fn new(net: IpNet, query: P, raw_limit: usize, cell_limit: usize) -> Result<Self> {
        let mut s = Self {
            net,
            raw: Vec::new(),
            raw_limit,
            cell_limit,
        };
        s.push(ordinal(net.network()), query, CutEdge::QueryStart, false)?;
        Ok(s)
    }
    fn push(&mut self, at: u128, predicate: P, edge: CutEdge, clipped: bool) -> Result<()> {
        checked(self.raw.len().checked_add(1), self.raw_limit, "raw_origins")?;
        self.raw
            .push((at, self.raw.len(), predicate, edge, clipped));
        Ok(())
    }
    pub(crate) fn membership(&mut self, value: IpNet, predicate: P) -> Result<()> {
        if value.addr().is_ipv4() != self.net.addr().is_ipv4() {
            return Ok(());
        }
        let (lo, hi) = (ordinal(self.net.network()), ordinal(self.net.broadcast()));
        let (nlo, nhi) = (ordinal(value.network()), ordinal(value.broadcast()));
        let (start, end) = (nlo.max(lo), nhi.min(hi));
        if start <= end {
            self.push(start, predicate, CutEdge::Enter, start != nlo)?;
            if end < hi {
                self.push(
                    end.checked_add(1)
                        .ok_or(SourceHandoffCidrError::PartitionProofUnavailable)?,
                    predicate,
                    CutEdge::Leave,
                    false,
                )?;
            }
        }
        Ok(())
    }
    pub(crate) fn finish<O>(
        mut self,
        mut origin: impl FnMut(usize, P, CutEdge, bool) -> O,
    ) -> Result<(Vec<u128>, Vec<O>)> {
        self.raw
            .sort_unstable_by_key(|(at, sequence, ..)| (*at, *sequence));
        let mut cuts = Vec::new();
        let mut origins = Vec::new();
        for (at, _, predicate, edge, clipped) in self.raw {
            if cuts.last() != Some(&at) {
                check(cuts.len() + 1, self.cell_limit, "segments")?;
                cuts.push(at);
            }
            origins.push(origin(cuts.len() - 1, predicate, edge, clipped));
        }
        Ok((cuts, origins))
    }
}
#[derive(Clone, Copy)]
pub(crate) enum VpcMembership {
    Route {
        resource_index: usize,
        route_index: usize,
    },
    Service {
        policy_index: usize,
    },
}
/// The original row/route/policy indexes survive filtering. VPC routes precede services.
pub(crate) fn visit_vpc_memberships(
    topology: &AwsTopology,
    mut visit: impl FnMut(IpNet, VpcMembership) -> Result<()>,
) -> Result<()> {
    for (resource_index, row) in topology
        .resources
        .iter()
        .enumerate()
        .filter(|(_, r)| r.kind == ResourceKind::RouteTable)
    {
        for (route_index, route) in row.routes.iter().enumerate() {
            if let Ok(value) = vpc_lookup::destination_network(route) {
                visit(
                    value,
                    VpcMembership::Route {
                        resource_index,
                        route_index,
                    },
                )?;
            }
        }
    }
    // Services have a stable policy order independent of topology resource indexes.
    for (policy_index, value) in vpc_lookup::reserved_service_networks()
        .into_iter()
        .enumerate()
    {
        visit(value, VpcMembership::Service { policy_index })?;
    }
    Ok(())
}
