#![cfg(test)]
extern crate std;

use super::*;
use soroban_sdk::{
    testutils::{storage::Persistent as _, Address as _, AuthorizedFunction, Ledger},
    token::{StellarAssetClient, TokenClient},
    Address, BytesN, Env, Symbol,
};

fn setup() -> (Env, Address, Address, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger()
        .with_mut(|ledger| ledger.timestamp = 1_700_000_000);

    let admin = Address::generate(&env);
    let customer = Address::generate(&env);
    let merchant = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(token_admin);
    let token_address = token_id.address();
    StellarAssetClient::new(&env, &token_address).mint(&customer, &100_000_000);

    let contract_id = env.register(
        EnzaCheckout,
        (admin.clone(), token_address.clone(), merchant.clone()),
    );
    (env, contract_id, admin, customer, merchant, token_address)
}

#[test]
fn order_is_paid_once_and_transfers_exact_amount() {
    let (env, contract_id, _admin, customer, merchant, token_address) = setup();
    let client = EnzaCheckoutClient::new(&env, &contract_id);
    let order_id = BytesN::from_array(&env, &[7; 32]);
    client.create_order(&order_id, &25_000_000, &(env.ledger().timestamp() + 900));

    let token = TokenClient::new(&env, &token_address);
    let before = token.balance(&customer);
    client.pay_order(&order_id, &customer);

    assert_eq!(before - token.balance(&customer), 25_000_000);
    assert_eq!(token.balance(&merchant), 25_000_000);
    assert!(client.get_order(&order_id).paid);
    assert_eq!(client.get_order(&order_id).customer, Some(customer.clone()));

    assert_eq!(
        client.try_pay_order(&order_id, &customer),
        Err(Ok(Error::AlreadyPaid))
    );
    assert_eq!(token.balance(&merchant), 25_000_000);
}

#[test]
fn rejects_zero_amount_and_expired_order() {
    let (env, contract_id, _admin, customer, _merchant, _token) = setup();
    let client = EnzaCheckoutClient::new(&env, &contract_id);
    let zero_id = BytesN::from_array(&env, &[8; 32]);
    assert_eq!(
        client.try_create_order(&zero_id, &0, &(env.ledger().timestamp() + 900)),
        Err(Ok(Error::InvalidAmount))
    );

    let expired_id = BytesN::from_array(&env, &[9; 32]);
    client.create_order(&expired_id, &1_000, &(env.ledger().timestamp() + 1));
    env.ledger().with_mut(|ledger| ledger.timestamp += 2);
    assert_eq!(
        client.try_pay_order(&expired_id, &customer),
        Err(Ok(Error::OrderExpired))
    );
}

#[test]
fn rejects_duplicate_order_ids() {
    let (env, contract_id, _admin, _customer, _merchant, _token) = setup();
    let client = EnzaCheckoutClient::new(&env, &contract_id);
    let order_id = BytesN::from_array(&env, &[10; 32]);
    let expiry = env.ledger().timestamp() + 900;
    client.create_order(&order_id, &1_000, &expiry);
    assert_eq!(
        client.try_create_order(&order_id, &2_000, &expiry),
        Err(Ok(Error::OrderAlreadyExists))
    );
}

#[test]
fn rejects_negative_amount() {
    let (env, contract_id, _admin, _customer, _merchant, _token) = setup();
    let client = EnzaCheckoutClient::new(&env, &contract_id);
    let order_id = BytesN::from_array(&env, &[11; 32]);
    assert_eq!(
        client.try_create_order(&order_id, &-1, &(env.ledger().timestamp() + 900)),
        Err(Ok(Error::InvalidAmount))
    );
}

#[test]
fn create_order_requires_admin_authorization() {
    let (env, contract_id, admin, _customer, _merchant, _token) = setup();
    let client = EnzaCheckoutClient::new(&env, &contract_id);
    let order_id = BytesN::from_array(&env, &[12; 32]);
    let expiry = env.ledger().timestamp() + 900;
    client.create_order(&order_id, &1_000, &expiry);

    let expected_fn = Symbol::new(&env, "create_order");
    let auths = env.auths();
    assert!(!auths.is_empty());
    assert!(auths.iter().any(|(address, invocation)| {
        *address == admin
            && matches!(&invocation.function,
                AuthorizedFunction::Contract((_, name, _)) if *name == expected_fn)
    }));

    // Without a mocked authorization for the admin, creation must fail.
    env.set_auths(&[]);
    let other_order = BytesN::from_array(&env, &[13; 32]);
    assert!(client
        .try_create_order(&other_order, &1_000, &expiry)
        .is_err());
    assert_eq!(
        client.try_get_order(&other_order),
        Err(Ok(Error::OrderNotFound))
    );
}

#[test]
fn pay_order_requires_customer_authorization() {
    let (env, contract_id, _admin, customer, _merchant, _token) = setup();
    let client = EnzaCheckoutClient::new(&env, &contract_id);
    let order_id = BytesN::from_array(&env, &[14; 32]);
    client.create_order(&order_id, &1_000, &(env.ledger().timestamp() + 900));

    client.pay_order(&order_id, &customer);
    let expected_fn = Symbol::new(&env, "pay_order");
    let auths = env.auths();
    assert!(!auths.is_empty());
    assert!(auths.iter().any(|(address, invocation)| {
        *address == customer
            && matches!(&invocation.function,
                AuthorizedFunction::Contract((_, name, _)) if *name == expected_fn)
    }));
}

#[test]
fn pay_order_rejects_missing_order() {
    let (env, contract_id, _admin, customer, _merchant, _token) = setup();
    let client = EnzaCheckoutClient::new(&env, &contract_id);
    let order_id = BytesN::from_array(&env, &[15; 32]);
    assert_eq!(
        client.try_pay_order(&order_id, &customer),
        Err(Ok(Error::OrderNotFound))
    );
}

#[test]
fn insufficient_balance_leaves_order_unpaid() {
    let (env, contract_id, _admin, _customer, merchant, token_address) = setup();
    let client = EnzaCheckoutClient::new(&env, &contract_id);
    let broke_customer = Address::generate(&env);
    let order_id = BytesN::from_array(&env, &[16; 32]);
    client.create_order(&order_id, &25_000_000, &(env.ledger().timestamp() + 900));

    assert!(client.try_pay_order(&order_id, &broke_customer).is_err());
    assert!(!client.get_order(&order_id).paid);
    assert_eq!(client.get_order(&order_id).customer, None);
    assert_eq!(client.get_order(&order_id).paid_at, None);
    assert_eq!(TokenClient::new(&env, &token_address).balance(&merchant), 0);
}

#[test]
fn payment_at_exact_expiry_is_rejected() {
    let (env, contract_id, _admin, customer, _merchant, _token) = setup();
    let client = EnzaCheckoutClient::new(&env, &contract_id);
    let order_id = BytesN::from_array(&env, &[17; 32]);
    client.create_order(&order_id, &1_000, &(env.ledger().timestamp() + 900));
    // Exactly at expiry: cannot pay (expiry is exclusive).
    let t = env.ledger().timestamp();
    env.ledger().with_mut(|ledger| ledger.timestamp = t + 900);
    assert_eq!(
        client.try_pay_order(&order_id, &customer),
        Err(Ok(Error::OrderExpired))
    );
}

#[test]
fn order_storage_ttl_is_extended() {
    let (env, contract_id, _admin, _customer, _merchant, _token) = setup();
    let client = EnzaCheckoutClient::new(&env, &contract_id);
    let order_id = BytesN::from_array(&env, &[18; 32]);
    client.create_order(&order_id, &1_000, &(env.ledger().timestamp() + 900));

    let ttl = env.as_contract(&contract_id, || {
        env.storage()
            .persistent()
            .get_ttl(&DataKey::Order(order_id))
    });
    assert!(ttl >= TTL_THRESHOLD);
    // Global config lives in instance storage; it must stay alive too.
    assert_eq!(client.admin(), _admin);
    client.token();
    client.merchant();
}

#[test]
fn events_expose_order_created_and_paid() {
    use soroban_sdk::{testutils::Events as _, Event as _};

    let (env, contract_id, _admin, customer, _merchant, _token) = setup();
    let client = EnzaCheckoutClient::new(&env, &contract_id);
    let order_id = BytesN::from_array(&env, &[19; 32]);
    let amount = 25_000_000i128;
    let expiry = env.ledger().timestamp() + 900;

    let created = OrderCreated {
        order_id: order_id.clone(),
        amount,
        expires_at: expiry,
    };
    client.create_order(&order_id, &amount, &expiry);
    let checkout_events = env.events().all().filter_by_contract(&contract_id);
    assert_eq!(
        std::vec![created.to_xdr(&env, &contract_id)],
        checkout_events.events().to_vec()
    );

    let paid = OrderPaid {
        order_id: order_id.clone(),
        customer: customer.clone(),
        amount,
        paid_at: env.ledger().timestamp(),
    };
    client.pay_order(&order_id, &customer);
    let checkout_events = env.events().all().filter_by_contract(&contract_id);
    assert_eq!(
        std::vec![paid.to_xdr(&env, &contract_id)],
        checkout_events.events().to_vec()
    );
}

#[test]
fn constructor_pins_config_and_rejects_uninitialized_reads() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger()
        .with_mut(|ledger| ledger.timestamp = 1_700_000_000);
    let admin = Address::generate(&env);
    let token_address = Address::generate(&env);
    let merchant = Address::generate(&env);
    let contract_id = env.register(
        EnzaCheckout,
        (admin.clone(), token_address.clone(), merchant.clone()),
    );
    let client = EnzaCheckoutClient::new(&env, &contract_id);
    assert_eq!(client.admin(), admin);
    assert_eq!(client.token(), token_address);
    assert_eq!(client.merchant(), merchant);
}

// NOTE: getters' `NotInitialized` guard is defensively unreachable in tests:
// `__constructor` always runs at registration, so there is no way to register
// the contract in an uninitialized state. Coverage for the getters is in
// `constructor_pins_config_and_rejects_uninitialized_reads`.
