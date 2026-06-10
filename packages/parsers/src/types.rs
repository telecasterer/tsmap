use serde::Serialize;
use std::collections::HashMap;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DieResult {
    pub x: i32,
    pub y: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hbin: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sbin: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub site_num: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub part_id: Option<u32>,
    #[serde(skip_serializing_if = "HashMap::is_empty")]
    pub test_values: HashMap<String, f64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestDef {
    pub name: String,
    pub test_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lo_limit: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hi_limit: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub units: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WaferData {
    pub wafer_id: String,
    pub results: Vec<DieResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub part_count: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub good_count: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fail_count: Option<u32>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LotMeta {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lot_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub part_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub job_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tester_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sublot_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteInfo {
    pub head_num: u32,
    pub site_num: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedStdf {
    pub meta: LotMeta,
    pub wafers: Vec<WaferData>,
    pub test_defs: HashMap<String, TestDef>,
    pub sites: Vec<SiteInfo>,
    /// Non-fatal advisories surfaced to the host (e.g. fabricated soft bins).
    /// Empty array is omitted from the serialised output.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}
