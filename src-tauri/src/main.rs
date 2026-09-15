// macOS application entry point: hide the console window on Windows targets.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    agents_usage_desktop::run();
}
