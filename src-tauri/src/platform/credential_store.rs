use keyring::{Entry, Error};
use std::sync::{Arc, Mutex};
pub const PRODUCTION_SERVICE: &str = "ai.touri.desktop.secret";
#[derive(Clone)]
pub struct KeychainStore {
    service: String,
    lock: Arc<Mutex<()>>,
}
fn storage_error(_: Error) -> String {
    // Error variants may carry secret bytes. Never include backend errors in logs/RPC.
    "Secret store unavailable; unlock the desktop secret service or credential manager".into()
}
fn optional(value: Result<String, Error>) -> Result<Option<String>, String> {
    match value {
        Ok(value) => Ok(Some(value)),
        Err(Error::NoEntry) => Ok(None),
        Err(error) => Err(storage_error(error)),
    }
}
impl KeychainStore {
    pub fn new(service: impl Into<String>) -> Self {
        Self {
            service: service.into(),
            lock: Arc::new(Mutex::new(())),
        }
    }
    fn entry(&self, account: &str) -> Result<Entry, String> {
        Entry::new(&self.service, account).map_err(storage_error)
    }
    pub fn get(&self, account: &str) -> Result<Option<String>, String> {
        let _guard = self.lock.lock().map_err(|_| "secret store lock poisoned")?;
        optional(self.entry(account)?.get_password())
    }
    pub fn set(&self, account: &str, value: &str) -> Result<(), String> {
        let _guard = self.lock.lock().map_err(|_| "secret store lock poisoned")?;
        self.entry(account)?
            .set_password(value)
            .map_err(storage_error)
    }
    pub fn delete(&self, account: &str) -> Result<(), String> {
        let _guard = self.lock.lock().map_err(|_| "secret store lock poisoned")?;
        match self.entry(account)?.delete_credential() {
            Ok(()) | Err(Error::NoEntry) => Ok(()),
            Err(error) => Err(storage_error(error)),
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn missing_is_optional_and_backend_errors_are_redacted() {
        assert_eq!(optional(Err(Error::NoEntry)).unwrap(), None);
        assert_eq!(
            optional(Ok("fixture".into())).unwrap(),
            Some("fixture".into())
        );
        assert!(
            !storage_error(Error::BadEncoding(b"secret-value".to_vec())).contains("secret-value")
        );
    }
    #[test]
    #[ignore = "requires an unlocked native desktop secret service"]
    fn native_secret_round_trip() {
        let store = KeychainStore::new("ai.touri.desktop.port-test");
        let account = format!("round-trip-{}", std::process::id());
        store.delete(&account).unwrap();
        assert_eq!(store.get(&account).unwrap(), None);
        store.set(&account, "port-test-fixture").unwrap();
        assert_eq!(
            store.get(&account).unwrap().as_deref(),
            Some("port-test-fixture")
        );
        store.set(&account, "updated-fixture").unwrap();
        assert_eq!(
            store.get(&account).unwrap().as_deref(),
            Some("updated-fixture")
        );
        store.delete(&account).unwrap();
        assert_eq!(store.get(&account).unwrap(), None);
    }
}
