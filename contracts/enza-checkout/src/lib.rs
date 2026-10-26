#![no_std]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, token, Address, BytesN, Env,
};

const TTL_THRESHOLD: u32 = 17_280 * 30;
const TTL_BUMP: u32 = 17_280 * 60;

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Token,
    Merchant,
    Order(BytesN<32>),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OrderRecord {
    pub amount: i128,
    pub expires_at: u64,
    pub paid: bool,
    pub customer: Option<Address>,
    pub paid_at: Option<u64>,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    InvalidAmount = 3,
    InvalidExpiry = 4,
    OrderAlreadyExists = 5,
    OrderNotFound = 6,
    OrderExpired = 7,
    AlreadyPaid = 8,
}

#[contractevent]
pub struct OrderCreated {
    #[topic]
    pub order_id: BytesN<32>,
    pub amount: i128,
    pub expires_at: u64,
}

#[contractevent]
pub struct OrderPaid {
    #[topic]
    pub order_id: BytesN<32>,
    #[topic]
    pub customer: Address,
    pub amount: i128,
    pub paid_at: u64,
}

#[contract]
pub struct EnzaCheckout;

#[contractimpl]
impl EnzaCheckout {
    pub fn __constructor(env: Env, admin: Address, token: Address, merchant: Address) {
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Token, &token);
        env.storage().instance().set(&DataKey::Merchant, &merchant);
    }

    /// Register an immutable payment request. Only the configured operator can create orders.
    /// Amounts use the token's smallest unit; never pass floating-point values.
    pub fn create_order(
        env: Env,
        order_id: BytesN<32>,
        amount: i128,
        expires_at: u64,
    ) -> Result<(), Error> {
        // Keep the contract instance (admin/token/merchant config) alive along
        // with order records; extend is a no-op unless TTL is below threshold.
        env.storage().instance().extend_ttl(TTL_THRESHOLD, TTL_BUMP);
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();

        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        if expires_at <= env.ledger().timestamp() {
            return Err(Error::InvalidExpiry);
        }

        let key = DataKey::Order(order_id.clone());
        if env.storage().persistent().has(&key) {
            return Err(Error::OrderAlreadyExists);
        }

        let order = OrderRecord {
            amount,
            expires_at,
            paid: false,
            customer: None,
            paid_at: None,
        };
        env.storage().persistent().set(&key, &order);
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD, TTL_BUMP);
        OrderCreated {
            order_id,
            amount,
            expires_at,
        }
        .publish(&env);
        Ok(())
    }

    /// Customer-authorized token transfer and order settlement happen atomically.
    /// The configured token address must be the intended Testnet asset contract.
    pub fn pay_order(env: Env, order_id: BytesN<32>, customer: Address) -> Result<(), Error> {
        // Keep the contract instance (token/merchant config) alive with orders.
        env.storage().instance().extend_ttl(TTL_THRESHOLD, TTL_BUMP);
        customer.require_auth();

        let key = DataKey::Order(order_id.clone());
        let mut order: OrderRecord = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::OrderNotFound)?;

        if order.paid {
            return Err(Error::AlreadyPaid);
        }
        let now = env.ledger().timestamp();
        if now >= order.expires_at {
            return Err(Error::OrderExpired);
        }

        let token_address: Address = env
            .storage()
            .instance()
            .get(&DataKey::Token)
            .ok_or(Error::NotInitialized)?;
        let merchant: Address = env
            .storage()
            .instance()
            .get(&DataKey::Merchant)
            .ok_or(Error::NotInitialized)?;

        token::Client::new(&env, &token_address).transfer(&customer, &merchant, &order.amount);

        order.paid = true;
        order.customer = Some(customer.clone());
        order.paid_at = Some(now);
        env.storage().persistent().set(&key, &order);
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD, TTL_BUMP);
        OrderPaid {
            order_id,
            customer,
            amount: order.amount,
            paid_at: now,
        }
        .publish(&env);
        Ok(())
    }

    pub fn get_order(env: Env, order_id: BytesN<32>) -> Result<OrderRecord, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Order(order_id))
            .ok_or(Error::OrderNotFound)
    }

    pub fn admin(env: Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)
    }

    pub fn token(env: Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Token)
            .ok_or(Error::NotInitialized)
    }

    pub fn merchant(env: Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Merchant)
            .ok_or(Error::NotInitialized)
    }
}

#[cfg(test)]
mod test;
