use core_foundation::data::CFData;
use security_framework::item::{
    update_item, ItemAddOptions, ItemAddValue, ItemClass, ItemSearchOptions, ItemUpdateOptions,
    ItemUpdateValue, Limit, SearchResult,
};

pub const PRODUCTION_SERVICE: &str = "ai.touri.desktop.secret";

#[derive(Clone)]
pub struct KeychainStore {
    service: String,
}

impl KeychainStore {
    pub fn new(service: impl Into<String>) -> Self {
        Self {
            service: service.into(),
        }
    }

    fn search(&self, account: &str, load_data: bool) -> ItemSearchOptions {
        let mut search = ItemSearchOptions::new();
        search
            .class(ItemClass::generic_password())
            .service(&self.service)
            .account(account)
            .limit(Limit::Max(1))
            .load_data(load_data);
        search
    }

    pub fn get(&self, account: &str) -> Result<Option<String>, String> {
        let results = match self.search(account, true).search() {
            Ok(results) => results,
            Err(error) if is_not_found(error) => return Ok(None),
            Err(error) => return Err(keychain_error(error)),
        };
        let Some(result) = results.into_iter().next() else {
            return Ok(None);
        };
        match result {
            SearchResult::Data(value) => String::from_utf8(value)
                .map(Some)
                .map_err(|_| "keychain value is not valid UTF-8".to_string()),
            _ => Err("keychain returned an unexpected item".to_string()),
        }
    }

    pub fn set(&self, account: &str, value: &str) -> Result<(), String> {
        let value_data = CFData::from_buffer(value.as_bytes());
        let search = self.search(account, false);
        let results = match search.search() {
            Ok(results) => results,
            Err(error) if is_not_found(error) => Vec::new(),
            Err(error) => return Err(keychain_error(error)),
        };
        if results.is_empty() {
            let mut add = ItemAddOptions::new(ItemAddValue::Data {
                class: ItemClass::generic_password(),
                data: value_data,
            });
            add.set_service(&self.service).set_account_name(account);
            add.add().map_err(keychain_error)
        } else {
            let mut update = ItemUpdateOptions::new();
            update
                .set_class(ItemClass::generic_password())
                .set_value(ItemUpdateValue::Data(value_data));
            update_item(&search, &update).map_err(keychain_error)
        }
    }

    pub fn delete(&self, account: &str) -> Result<(), String> {
        match self.search(account, false).delete() {
            Ok(()) => Ok(()),
            Err(error) if is_not_found(error) => Ok(()),
            Err(error) => Err(keychain_error(error)),
        }
    }
}

fn keychain_error(error: security_framework::base::Error) -> String {
    format!("keychain operation failed ({}): {error}", error.code())
}

fn is_not_found(error: security_framework::base::Error) -> bool {
    error.code() == -25300
}

#[cfg(test)]
mod tests {
    use super::KeychainStore;

    const TEST_SERVICE: &str = "ai.touri.desktop.secret.wp1-test";
    const TEST_ACCOUNT: &str = "global/WP1_TEST_SECRET";

    #[test]
    fn dedicated_test_service_round_trips_and_cleans_up() {
        let store = KeychainStore::new(TEST_SERVICE);
        store.delete(TEST_ACCOUNT).expect("remove stale test item");
        store
            .set(TEST_ACCOUNT, "wp1-keychain-value")
            .expect("write test item");
        assert_eq!(
            store.get(TEST_ACCOUNT).expect("read test item").as_deref(),
            Some("wp1-keychain-value")
        );
        store.delete(TEST_ACCOUNT).expect("delete test item");
        assert_eq!(store.get(TEST_ACCOUNT).expect("verify cleanup"), None);
    }
}
