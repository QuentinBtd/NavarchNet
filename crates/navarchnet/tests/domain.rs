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

#[test]
fn shared_managed_route_table_has_one_default_action_after_all_selected_az_prerequisites() {
    let (mut inventory, network, request) = fixture();
    let shared = inventory.subnets[0].route_table.clone();
    inventory.subnets[1].route_table = shared.clone();
    let original = serde_json::to_value((&inventory, &network, &request)).unwrap();
    let actions = plan(&inventory, &network, &request).unwrap();
    let defaults: Vec<_> = actions
        .iter()
        .filter(|action| action.kind == ActionKind::SpokeDefaultRoute)
        .collect();
    assert_eq!(
        defaults.len(),
        1,
        "One shared managed table must produce one resource action, not one per selected subnet"
    );
    assert_eq!(defaults[0].target, shared);
    assert_eq!(defaults[0].requires, vec![0, 1, 2, 3, 4]);
    assert_eq!(actions.len(), 6);
    assert_eq!(actions[0].kind, ActionKind::Attachment);
    assert_eq!(actions[1].kind, ActionKind::Isolation);
    assert_eq!(actions[2].kind, ActionKind::ReturnRoute);
    assert_eq!(actions[3].kind, ActionKind::NatRoute);
    assert_eq!(actions[3].target, inventory.subnets[0].az_id);
    assert_eq!(actions[4].kind, ActionKind::NatRoute);
    assert_eq!(actions[4].target, inventory.subnets[1].az_id);
    assert_eq!(
        original,
        serde_json::to_value((&inventory, &network, &request)).unwrap()
    );
    let mut reordered = inventory.clone();
    reordered.subnets.reverse();
    let mut reversed_request = request.clone();
    reversed_request.subnet_ids.reverse();
    assert_eq!(
        serde_json::to_value(&actions).unwrap(),
        serde_json::to_value(plan(&reordered, &network, &reversed_request).unwrap()).unwrap()
    );
}

#[test]
fn shared_table_dedup_keeps_canonical_action_order_and_validates_every_selected_subnet() {
    let (mut inventory, mut network, mut request) = fixture();
    inventory.subnets[0].route_table = "rtb-z".into();
    inventory.subnets[1].route_table = "rtb-a".into();
    let mut third = inventory.subnets[0].clone();
    third.id = "subnet-c".into();
    third.az_id = "euw1-az3".into();
    request.subnet_ids.push(third.id.clone());
    network.az_ids.push(third.az_id.clone());
    inventory.subnets.push(third);
    let actions = plan(&inventory, &network, &request).unwrap();
    let defaults: Vec<_> = actions
        .iter()
        .filter(|action| action.kind == ActionKind::SpokeDefaultRoute)
        .collect();
    assert_eq!(
        defaults
            .iter()
            .map(|action| action.target.as_str())
            .collect::<Vec<_>>(),
        vec!["rtb-z", "rtb-a"]
    );
    assert!(
        defaults
            .iter()
            .all(|action| action.requires == vec![0, 1, 2, 3, 4, 5])
    );
    assert_eq!(
        actions
            .iter()
            .filter(|action| action.kind == ActionKind::NatRoute)
            .count(),
        3
    );
    let expected = serde_json::to_value(&actions).unwrap();
    inventory.subnets.reverse();
    request.subnet_ids.reverse();
    assert_eq!(
        expected,
        serde_json::to_value(plan(&inventory, &network, &request).unwrap()).unwrap()
    );

    for unmanaged in [0, 1] {
        let (mut inventory, network, request) = fixture();
        inventory.subnets[1].route_table = inventory.subnets[0].route_table.clone();
        inventory.subnets[unmanaged].default_route_managed = false;
        let before = serde_json::to_value(&inventory).unwrap();
        let error = plan(&inventory, &network, &request).unwrap_err();
        assert!(error.to_string().contains("adoption required"), "{error}");
        assert_eq!(before, serde_json::to_value(&inventory).unwrap());
    }
    let (mut inventory, network, request) = fixture();
    inventory.subnets[1].route_table = inventory.subnets[0].route_table.clone();
    inventory.subnets[1].az_id = inventory.subnets[0].az_id.clone();
    assert!(
        plan(&inventory, &network, &request)
            .unwrap_err()
            .to_string()
            .contains("one attachment subnet per AZ")
    );
}
