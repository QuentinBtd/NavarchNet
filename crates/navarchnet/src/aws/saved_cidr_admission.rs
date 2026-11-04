//! Private single-capture admission shared by saved CIDR analyzers.
use super::source_handoff_cidr_coverage::{
    SourceHandoffCidrBudget, SourceHandoffCidrError, add, check, checked, exceeded,
};
use super::{VerifiedAccount, observation::*, saved_observation::SavedObservation};
type Result<T> = std::result::Result<T, SourceHandoffCidrError>;
#[derive(Default)]
pub(crate) struct Census {
    pub(crate) r: usize,
    pub(crate) a: usize,
    pub(crate) l: usize,
    pub(crate) k: usize,
    pub(crate) n: usize,
    pub(crate) t: usize,
    pub(crate) h: usize,
    pub(crate) c: usize,
    pub(crate) m: usize,
    pub(crate) rn: usize,
    pub(crate) ln: usize,
    pub(crate) hn: usize,
    pub(crate) us: usize,
    pub(crate) work_limit: usize,
}
impl Census {
    pub(crate) fn base(&self) -> Result<usize> {
        checked(
            [
                self.r, self.a, self.l, self.k, self.n, self.t, self.h, self.c, self.m,
            ]
            .into_iter()
            .try_fold(1usize, usize::checked_add),
            self.work_limit,
            "work_units",
        )
    }
}
pub(crate) fn admit_capture(
    v: &mut Census,
    topology: &AwsTopology,
    network: bool,
    b: SourceHandoffCidrBudget,
) -> Result<()> {
    let (before_l, before_h) = (v.l, v.h);
    add(&mut v.r, topology.resources.len(), b.resources, "resources")?;
    add(
        &mut v.m,
        topology.request_ids.len(),
        b.other_entries,
        "other_entries",
    )?;
    add(
        &mut v.m,
        topology.limitations.len(),
        b.other_entries,
        "other_entries",
    )?;
    for row in &topology.resources {
        if !network && row.kind == ResourceKind::Subnet {
            v.us =
                v.us.checked_add(1)
                    .ok_or_else(|| exceeded("source_resources", b.source_resources))?;
        }
        add(
            &mut v.a,
            row.associations.len(),
            b.associations,
            "associations",
        )?;
        add(
            &mut v.l,
            row.related_ids.len(),
            b.related_ids,
            "related_ids",
        )?;
        add(&mut v.c, row.cidrs.len(), b.cidrs, "cidrs")?;
        for length in [row.public_ips.len(), row.private_ips.len(), row.tags.len()] {
            add(&mut v.m, length, b.other_entries, "other_entries")?;
        }
        if let Some(nat) = &row.nat_gateway {
            add(
                &mut v.m,
                nat.addresses.as_ref().map_or(0, Vec::len),
                b.other_entries,
                "other_entries",
            )?;
        }
        for links in [&row.tgw_associations, &row.tgw_propagations]
            .into_iter()
            .flatten()
        {
            add(&mut v.k, links.len(), b.links, "links")?;
        }
        add(&mut v.n, row.routes.len(), b.routes, "routes")?;
        for route in &row.routes {
            add(&mut v.t, route.targets.len(), b.targets, "targets")?;
        }
        if let Some(routes) = &row.tgw_routes {
            add(&mut v.n, routes.len(), b.routes, "routes")?;
            for route in routes {
                add(
                    &mut v.h,
                    route.attachments.len(),
                    b.attachments,
                    "attachments",
                )?;
            }
        }
    }
    if network {
        v.rn = topology.resources.len();
        v.ln =
            v.l.checked_sub(before_l)
                .ok_or(SourceHandoffCidrError::PartitionProofUnavailable)?;
        v.hn =
            v.h.checked_sub(before_h)
                .ok_or(SourceHandoffCidrError::PartitionProofUnavailable)?;
    }
    Ok(())
}
fn leaves<const N: usize>(values: [Option<&str>; N], b: SourceHandoffCidrBudget) -> Result<()> {
    for value in values.into_iter().flatten() {
        check(value.len(), b.string_bytes, "string_bytes")?;
    }
    Ok(())
}
/// Exhaustive destructuring intentionally makes newly added model fields a compile-time review
/// requirement, rather than silently forgetting an unbounded string or nested collection.
pub(crate) fn strings(saved: &SavedObservation, b: SourceHandoffCidrBudget) -> Result<()> {
    let SavedObservation {
        registration,
        saved_row_id,
        generation: _,
        topology,
        admitted_bytes: _,
    } = saved;
    let VerifiedAccount {
        id,
        name,
        role_arn,
        aws_account_id,
        region,
        verified_at,
        verified_session_name,
        execution_enabled: _,
    } = registration;
    leaves(
        [
            Some(id.as_str()),
            Some(name.as_str()),
            Some(role_arn.as_str()),
            Some(aws_account_id.as_str()),
            Some(region.as_str()),
            Some(verified_at.as_str()),
            Some(verified_session_name.as_str()),
            Some(saved_row_id.as_str()),
        ],
        b,
    )?;
    check(region.len(), b.region_bytes, "region_bytes")?;
    let AwsTopology {
        id,
        account_id,
        aws_account_id,
        region,
        started_at,
        completed_at,
        session_name,
        resources,
        request_ids,
        complete_for_supported_queries: _,
        limitations,
        execution_enabled: _,
        connectivity_tested: _,
    } = topology;
    leaves(
        [
            Some(id.as_str()),
            Some(account_id.as_str()),
            Some(aws_account_id.as_str()),
            Some(region.as_str()),
            Some(started_at.as_str()),
            Some(completed_at.as_str()),
            Some(session_name.as_str()),
        ],
        b,
    )?;
    check(region.len(), b.region_bytes, "region_bytes")?;
    for value in request_ids.iter().chain(limitations) {
        leaves([Some(value.as_str())], b)?;
    }
    for row in resources {
        let AwsResource {
            kind: _,
            id,
            owner_account_id,
            vpc_id,
            subnet_id,
            az_id,
            state,
            cidrs,
            public_ips,
            private_ips,
            tags,
            routes,
            associations,
            tgw_associations,
            tgw_propagations,
            tgw_routes,
            related_ids,
            connectivity_type,
            availability_mode,
            nat_gateway,
            managed: _,
        } = row;
        leaves(
            [
                Some(id.as_str()),
                owner_account_id.as_deref(),
                vpc_id.as_deref(),
                subnet_id.as_deref(),
                az_id.as_deref(),
                state.as_deref(),
                connectivity_type.as_deref(),
                availability_mode.as_deref(),
            ],
            b,
        )?;
        for value in cidrs
            .iter()
            .chain(public_ips)
            .chain(private_ips)
            .chain(related_ids)
        {
            leaves([Some(value.as_str())], b)?;
        }
        for (key, value) in tags {
            leaves([Some(key.as_str()), Some(value.as_str())], b)?;
        }
        for row in associations {
            let RouteAssociation {
                id,
                subnet_id,
                gateway_id,
                state,
                main: _,
            } = row;
            leaves(
                [
                    id.as_deref(),
                    subnet_id.as_deref(),
                    gateway_id.as_deref(),
                    state.as_deref(),
                ],
                b,
            )?;
        }
        for row in routes {
            let ObservedRoute {
                ipv4_destination,
                ipv6_destination,
                prefix_list_destination,
                state,
                origin,
                targets,
            } = row;
            leaves(
                [
                    ipv4_destination.as_deref(),
                    ipv6_destination.as_deref(),
                    prefix_list_destination.as_deref(),
                    state.as_deref(),
                    origin.as_deref(),
                ],
                b,
            )?;
            for (key, value) in targets {
                leaves([Some(key.as_str()), Some(value.as_str())], b)?;
            }
        }
        for row in tgw_associations
            .iter()
            .flatten()
            .chain(tgw_propagations.iter().flatten())
        {
            let TransitGatewayTableLink {
                attachment_id,
                resource_id,
                resource_type,
                state,
                route_table_announcement_id,
            } = row;
            leaves(
                [
                    attachment_id.as_deref(),
                    resource_id.as_deref(),
                    resource_type.as_deref(),
                    state.as_deref(),
                    route_table_announcement_id.as_deref(),
                ],
                b,
            )?;
        }
        for row in tgw_routes.iter().flatten() {
            let TransitGatewayRoute {
                destination_cidr,
                prefix_list_id,
                state,
                route_type,
                route_table_announcement_id,
                attachments,
            } = row;
            leaves(
                [
                    destination_cidr.as_deref(),
                    prefix_list_id.as_deref(),
                    state.as_deref(),
                    route_type.as_deref(),
                    route_table_announcement_id.as_deref(),
                ],
                b,
            )?;
            for row in attachments {
                let TransitGatewayRouteAttachment {
                    attachment_id,
                    resource_id,
                    resource_type,
                } = row;
                leaves(
                    [
                        attachment_id.as_deref(),
                        resource_id.as_deref(),
                        resource_type.as_deref(),
                    ],
                    b,
                )?;
            }
        }
        if let Some(nat) = nat_gateway {
            let NatGatewayMetadata {
                route_table_id,
                addresses,
            } = nat;
            leaves([route_table_id.as_deref()], b)?;
            for row in addresses.iter().flatten() {
                let NatGatewayAddress {
                    allocation_id,
                    association_id,
                    network_interface_id,
                    public_ip,
                    private_ip,
                    az_name,
                    az_id,
                    is_primary: _,
                    status,
                } = row;
                leaves(
                    [
                        allocation_id.as_deref(),
                        association_id.as_deref(),
                        network_interface_id.as_deref(),
                        public_ip.as_deref(),
                        private_ip.as_deref(),
                        az_name.as_deref(),
                        az_id.as_deref(),
                        status.as_deref(),
                    ],
                    b,
                )?;
            }
        }
    }
    Ok(())
}
