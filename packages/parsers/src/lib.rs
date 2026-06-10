pub mod types;
pub mod read_file;
pub mod parse_stdf;
pub mod parse_atdf;
pub mod parse_csv;
pub mod parse_json;

#[cfg(target_arch = "wasm32")]
mod wasm {
    use wasm_bindgen::prelude::*;
    use serde::Serialize;
    use crate::parse_csv::CsvMapping;

    // Route Rust panics to console.error with a stack trace. Without this a
    // panic in the parser becomes an opaque WASM trap that aborts the module
    // with no diagnostic — a dead page. The bounds-checked byte readers mean a
    // truncated file returns Err rather than panicking, but this catches any
    // residual panic surface.
    #[wasm_bindgen(start)]
    pub fn init() {
        console_error_panic_hook::set_once();
    }

    fn to_js<T: Serialize>(val: &T) -> JsValue {
        val.serialize(&serde_wasm_bindgen::Serializer::json_compatible()).unwrap()
    }

    #[wasm_bindgen]
    pub fn parse_stdf(bytes: &[u8]) -> Result<JsValue, JsValue> {
        crate::parse_stdf::parse_stdf_from_bytes(bytes)
            .map(|r| to_js(&r))
            .map_err(|e| JsValue::from_str(&e))
    }

    #[wasm_bindgen]
    pub fn parse_atdf(bytes: &[u8]) -> Result<JsValue, JsValue> {
        crate::parse_atdf::parse_atdf_from_bytes(bytes)
            .map(|r| to_js(&r))
            .map_err(|e| JsValue::from_str(&e))
    }

    #[wasm_bindgen]
    pub fn parse_csv(bytes: &[u8], mapping: JsValue) -> Result<JsValue, JsValue> {
        // Round-trip through JSON so null fields deserialise as Option::None correctly.
        // serde_wasm_bindgen::from_value treats JS null differently from undefined,
        // causing Option<String> fields to fail when the TS side sends null.
        let json = js_sys::JSON::stringify(&mapping)
            .map_err(|e| JsValue::from_str(&format!("mapping stringify failed: {:?}", e)))?;
        let json_str: String = json.into();
        let mapping: crate::parse_csv::CsvMapping = serde_json::from_str(&json_str)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        crate::parse_csv::parse_csv_from_bytes(bytes, mapping)
            .map(|r| to_js(&r))
            .map_err(|e| JsValue::from_str(&e))
    }

    #[wasm_bindgen]
    pub fn parse_json(bytes: &[u8], mapping: JsValue) -> Result<JsValue, JsValue> {
        let json = js_sys::JSON::stringify(&mapping)
            .map_err(|e| JsValue::from_str(&format!("mapping stringify failed: {:?}", e)))?;
        let json_str: String = json.into();
        let mapping: CsvMapping = serde_json::from_str(&json_str)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        crate::parse_json::parse_json_from_bytes(bytes, mapping)
            .map(|r| to_js(&r))
            .map_err(|e| JsValue::from_str(&e))
    }

    #[wasm_bindgen]
    pub fn stdf_test_names(bytes: &[u8]) -> Result<JsValue, JsValue> {
        crate::parse_stdf::parse_stdf_test_names(bytes)
            .map(|r| to_js(&r))
            .map_err(|e| JsValue::from_str(&e))
    }

    #[wasm_bindgen]
    pub fn parse_stdf_filtered(bytes: &[u8], selected: JsValue) -> Result<JsValue, JsValue> {
        let selected: Vec<u32> = serde_wasm_bindgen::from_value(selected)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        let set: std::collections::HashSet<u32> = selected.into_iter().collect();
        crate::parse_stdf::parse_stdf_from_bytes_filtered(bytes, &set)
            .map(|r| to_js(&r))
            .map_err(|e| JsValue::from_str(&e))
    }

    #[wasm_bindgen]
    pub fn atdf_test_names(bytes: &[u8]) -> Result<JsValue, JsValue> {
        crate::parse_atdf::parse_atdf_test_names(bytes)
            .map(|r| to_js(&r))
            .map_err(|e| JsValue::from_str(&e))
    }

    #[wasm_bindgen]
    pub fn parse_atdf_filtered(bytes: &[u8], selected: JsValue) -> Result<JsValue, JsValue> {
        let selected: Vec<u32> = serde_wasm_bindgen::from_value(selected)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        let set: std::collections::HashSet<u32> = selected.into_iter().collect();
        crate::parse_atdf::parse_atdf_from_bytes_filtered(bytes, &set)
            .map(|r| to_js(&r))
            .map_err(|e| JsValue::from_str(&e))
    }
}
