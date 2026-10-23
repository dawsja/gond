use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    pub server: Option<String>,
    pub bounds: Option<Bounds>,
    pub maximized: bool,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct Bounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

fn file(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join("config.json"))
}

fn read_json(path: &PathBuf) -> Option<serde_json::Value> {
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

pub fn read(app: &AppHandle) -> Config {
    file(app)
        .and_then(|path| read_json(&path))
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default()
}

/// Writes `config` over what the file holds, so a key this version doesn't
/// know stays as it was.
pub fn write(app: &AppHandle, config: &Config) -> Result<(), String> {
    let path = file(app).ok_or_else(|| "no config directory".to_string())?;
    let mut merged = read_json(&path)
        .filter(serde_json::Value::is_object)
        .unwrap_or_else(|| serde_json::json!({}));
    let patch = serde_json::to_value(config).map_err(|error| error.to_string())?;
    if let (Some(into), Some(from)) = (merged.as_object_mut(), patch.as_object()) {
        for (key, value) in from {
            into.insert(key.clone(), value.clone());
        }
    }
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    }
    let text = serde_json::to_string_pretty(&merged).map_err(|error| error.to_string())?;
    fs::write(&path, text).map_err(|error| error.to_string())
}
