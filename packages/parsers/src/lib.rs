pub mod types;
pub mod read_file;
pub mod parse_stdf;
pub mod parse_atdf;
pub mod parse_csv;
pub mod parse_json;

#[cfg(target_arch = "wasm32")]
mod wasm {
    use wasm_bindgen::prelude::*;
    use serde_wasm_bindgen::to_value;
    use crate::parse_csv::CsvMapping;

    #[wasm_bindgen]
    pub fn parse_stdf(bytes: &[u8]) -> Result<JsValue, JsValue> {
        crate::parse_stdf::parse_stdf_from_bytes(bytes)
            .map(|r| to_value(&r).unwrap())
            .map_err(|e| JsValue::from_str(&e))
    }

    #[wasm_bindgen]
    pub fn parse_atdf(bytes: &[u8]) -> Result<JsValue, JsValue> {
        crate::parse_atdf::parse_atdf_from_bytes(bytes)
            .map(|r| to_value(&r).unwrap())
            .map_err(|e| JsValue::from_str(&e))
    }

    // csv_headers and parse_csv require a path-based reader (csv crate streams from file).
    // These need a bytes-based reader variant before they can be exposed via WASM.
    // parse_json works because it reads the whole file to a string first.
    #[wasm_bindgen]
    pub fn parse_csv(_bytes: &[u8], _mapping: JsValue) -> Result<JsValue, JsValue> {
        Err(JsValue::from_str("parse_csv from bytes not yet implemented — needs bytes-based CSV reader"))
    }

    #[wasm_bindgen]
    pub fn parse_json(bytes: &[u8], mapping: JsValue) -> Result<JsValue, JsValue> {
        let mapping: CsvMapping = serde_wasm_bindgen::from_value(mapping)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        crate::parse_json::parse_json_from_bytes(bytes, mapping)
            .map(|r| to_value(&r).unwrap())
            .map_err(|e| JsValue::from_str(&e))
    }
}
