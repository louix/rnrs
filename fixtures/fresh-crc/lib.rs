pub mod rnrs_interface;

#[derive(Default)]
pub struct Module;

impl rnrs_interface::CrcModule for Module {
    fn crc32(&self, data: Vec<u8>) -> Result<f64, String> {
        Ok(crc32fast::hash(&data) as f64)
    }
    fn crc32_hex(&self, text: String) -> Result<String, String> {
        Ok(format!("{:08x}", crc32fast::hash(text.as_bytes())))
    }
}

#[cfg(test)]
mod tests {
    use super::rnrs_interface::CrcModule;

    #[test]
    fn check_value() {
        assert_eq!(super::Module.crc32(b"123456789".to_vec()).unwrap(), 3421780262.0);
        assert_eq!(super::Module.crc32_hex("123456789".into()).unwrap(), "cbf43926");
    }
}
