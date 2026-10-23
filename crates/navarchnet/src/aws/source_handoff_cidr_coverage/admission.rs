//! Source-specific two-capture admission order and unchanged point reservations.
use super::*;
pub(super) use crate::aws::saved_cidr_admission::strings;
use crate::aws::saved_cidr_admission::{Census, admit_capture};
impl Census {
    pub(super) fn reserve(
        &self,
        source: &SavedObservation,
        i: usize,
        q: usize,
        base: usize,
        b: SourceHandoffCidrBudget,
    ) -> Result<()> {
        // Units: collection visits/index API calls/clone slots/sort input elements. NOT internal
        // BTree/sort comparisons, byte scans, instructions, allocator operations or CPU/RSS/time.
        let cross = checked(self.rn.checked_mul(self.ln), b.work_units, "work_units")?;
        let g = source
            .topology
            .region
            .bytes()
            .filter(|v| *v == b'-')
            .count()
            .checked_add(1);
        let per = self
            .base()?
            .checked_add(cross)
            .and_then(|n| n.checked_add(g?));
        let points = per
            .and_then(|n| n.checked_mul(64))
            .and_then(|n| n.checked_mul(i));
        let aux = q.checked_add(i).and_then(|n| n.checked_mul(64));
        checked(
            points
                .and_then(|n| n.checked_add(base))
                .and_then(|n| n.checked_add(aux?)),
            b.work_units,
            "work_units",
        )?;
        // Routing may clone one large shared table ID into EVERY source subnet on EVERY cell.
        // Also reserve attempted/discarded point-string clones and generated witness/end strings.
        let slots = self
            .us
            .checked_mul(3)
            .and_then(|n| n.checked_add(10))
            .and_then(|n| n.checked_add(self.hn));
        let payload = slots
            .and_then(|n| n.checked_mul(b.string_bytes))
            .and_then(|n| n.checked_add(117))
            .and_then(|n| n.checked_mul(i));
        checked(payload, b.clone_payload_bytes, "clone_payload_bytes")?;
        Ok(())
    }
}
pub(super) fn census(
    s: &SavedObservation,
    n: &SavedObservation,
    b: SourceHandoffCidrBudget,
) -> Result<Census> {
    check(
        s.topology.resources.len(),
        b.source_resources,
        "source_resources",
    )?;
    check(
        n.topology.resources.len(),
        b.network_resources,
        "network_resources",
    )?;
    let mut v = Census {
        work_limit: b.work_units,
        ..Census::default()
    };
    for (network, topology) in [(false, &s.topology), (true, &n.topology)] {
        admit_capture(&mut v, topology, network, b)?;
    }
    Ok(v)
}
