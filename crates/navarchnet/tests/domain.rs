use navarchnet::domain::*;
use proptest::prelude::*;

#[test]
fn fake_discovery_resources_are_scoped_to_the_registered_account() {
    let account = |id: &str| Account {
        id: id.into(),
        name: "App".into(),
        provider: ProviderKind::Fake,
        role_arn: "fake:role".into(),
        revision: 1,
    };
    let first = navarchnet::provider::discover(&account("first-account")).unwrap();
    let second = navarchnet::provider::discover(&account("second-account")).unwrap();
    assert_ne!(first.cidr, second.cidr);
    assert!(first.subnets.iter().all(|a| {
        second
            .subnets
            .iter()
            .all(|b| a.id != b.id && a.route_table != b.route_table)
    }));
    assert!(!navarchnet::provider::capabilities(&ProviderKind::Aws).execution);
}

#[test]
fn isolation_and_return_routes_precede_default_route() {
    let (inventory, network, request) = fixture();
    let actions = plan(&inventory, &network, &request).unwrap();
    assert_eq!(actions.last().unwrap().kind, ActionKind::SpokeDefaultRoute);
    assert!(actions.iter().any(|a| a.kind == ActionKind::ReturnRoute));
    assert!(actions.iter().any(|a| a.kind == ActionKind::Isolation));
    assert!(!actions.iter().any(|a| a.target.contains("propagate-all")));
    for (i, action) in actions.iter().enumerate() {
        assert!(action.requires.iter().all(|p| *p < i as u32));
    }
}

#[test]
fn refuses_unowned_routes_cross_region_and_duplicate_az() {
    let (mut inventory, mut network, mut request) = fixture();
    inventory.subnets[0].default_route_managed = false;
    assert!(plan(&inventory, &network, &request).is_err());
    inventory.subnets[0].default_route_managed = true;
    network.region = "us-west-2".into();
    assert!(plan(&inventory, &network, &request).is_err());
    network.region = inventory.region.clone();
    request.subnet_ids = vec!["subnet-a".into(), "subnet-a".into()];
    assert!(plan(&inventory, &network, &request).is_err());
}

#[test]
fn rejects_overlap_ipv6_and_unsupported_connectivity() {
    let (mut inventory, mut network, request) = fixture();
    network.application_cidrs.push(inventory.cidr.clone());
    assert!(plan(&inventory, &network, &request).is_err());
    network.application_cidrs.clear();
    inventory.cidr = "2001:db8::/64".into();
    assert!(plan(&inventory, &network, &request).is_err());
}

#[test]
fn selected_subnet_identity_must_be_unique_in_discovered_inventory() {
    let (inventory, network, request) = fixture();
    let expected = serde_json::to_value(plan(&inventory, &network, &request).unwrap()).unwrap();
    let mut reversed = inventory.clone();
    reversed.subnets.reverse();
    assert_eq!(
        expected,
        serde_json::to_value(plan(&reversed, &network, &request).unwrap()).unwrap()
    );
    let mut single = request.clone();
    single.subnet_ids.truncate(1);
    let mut unrelated = inventory.clone();
    unrelated.subnets.push(inventory.subnets[1].clone());
    assert_eq!(
        serde_json::to_value(plan(&inventory, &network, &single).unwrap()).unwrap(),
        serde_json::to_value(plan(&unrelated, &network, &single).unwrap()).unwrap(),
        "Duplicate unselected rows must not change the selected unique subnet's plan"
    );
    for variant in ["identical", "different route", "unmanaged route"] {
        let mut duplicate = inventory.subnets[0].clone();
        if variant == "different route" {
            duplicate.route_table = "rtb-conflicting-literal".into();
        }
        if variant == "unmanaged route" {
            duplicate.default_route_managed = false;
        }
        for reverse in [false, true] {
            let mut ambiguous = inventory.clone();
            ambiguous.subnets.push(duplicate.clone());
            if reverse {
                ambiguous.subnets.reverse();
            }
            let before = serde_json::to_value(&ambiguous).unwrap();
            let error = plan(&ambiguous, &network, &request)
                .expect_err("Duplicate discovered subnet IDs must never select a first row");
            assert!(error.to_string().contains("ambiguous"), "{error}");
            assert_eq!(before, serde_json::to_value(&ambiguous).unwrap());
        }
    }
}

proptest! {
    #[test]
    fn all_generated_plans_preserve_activation_order(n in 1usize..=2) {
        let (inventory, network, mut request) = fixture();
        request.subnet_ids.truncate(n);
        let actions = plan(&inventory, &network, &request).unwrap();
        let isolation = actions.iter().position(|a| a.kind == ActionKind::Isolation).unwrap();
        let activation = actions.iter().position(|a| a.kind == ActionKind::SpokeDefaultRoute).unwrap();
        prop_assert!(isolation < activation);
        prop_assert!(actions[..activation].iter().any(|a| a.kind == ActionKind::ReturnRoute));
    }
}
