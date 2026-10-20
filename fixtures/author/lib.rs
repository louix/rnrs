//! The author's implementation of xor.spec.ts.
pub mod rnr_interface;

#[derive(Default)]
pub struct Module;

impl rnr_interface::XorModule for Module {
    fn xor(&self, mut data: Vec<u8>, key: f64) -> Result<Vec<u8>, String> {
        if !(key.fract() == 0.0 && (0.0..=255.0).contains(&key)) {
            return Err("key must be an integer from 0 to 255".into());
        }
        data.iter_mut().for_each(|b| *b ^= key as u8);
        Ok(data)
    }

    fn greet(&self, name: String) -> Result<String, String> {
        Ok(format!("hello, {name}"))
    }
}

#[cfg(test)]
mod tests {
    use super::rnr_interface::XorModule;

    #[test]
    fn xor_round_trips_and_validates() {
        let m = super::Module;
        assert_eq!(m.xor(vec![0, 1, 255], 255.0).unwrap(), vec![255, 254, 0]);
        assert_eq!(m.xor(vec![], 7.0).unwrap(), Vec::<u8>::new());
        assert!(m.xor(vec![1], 256.0).is_err());
        assert!(m.xor(vec![1], 1.5).is_err());
    }
}
