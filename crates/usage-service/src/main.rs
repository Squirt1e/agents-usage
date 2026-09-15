//! Standalone loopback usage service entry point.
//!
//! Owns the desktop data directory, performs the read-only collection and serves
//! the authenticated loopback API for the desktop panel and companion web page.

use std::process::ExitCode;

const USAGE: &str = "\
usage-service — loopback usage service for the macOS menubar panel

USAGE:
    usage-service [--version] [--self-check] [--timezone <IANA>] [--port <port>]

OPTIONS:
    --version          Print the service version and exit
    --self-check       Run build-time checks that do not touch the network,
                       Keychain or the data directory, then exit
    --timezone <IANA>  Timezone for daily statistics (default: system/UTC)
    --port <port>      Preferred loopback port (default: 47160)
    -h, --help         Print this help
";

#[tokio::main]
async fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("-h") | Some("--help") => {
            print!("{USAGE}");
            return ExitCode::SUCCESS;
        }
        Some("--version") => {
            println!("usage-service {}", usage_core::VERSION);
            return ExitCode::SUCCESS;
        }
        Some("--self-check") => {
            if usage_core::core_ready() {
                println!("usage-core {} ready", usage_core::VERSION);
                return ExitCode::SUCCESS;
            }
            eprintln!("usage-core is not ready");
            return ExitCode::FAILURE;
        }
        Some(other) if !other.starts_with("--") => {
            eprintln!("unknown argument: {other}\n\n{USAGE}");
            return ExitCode::from(2);
        }
        _ => {}
    }

    let mut config = usage_service::ServiceConfig::default();
    // Environment parity with the legacy Node dashboard: the same variables
    // select the data directory, host, port and timezone, so the desktop service
    // can be pointed at an isolated directory for tests and diagnostics.
    if let Ok(data_dir) = std::env::var("AGENTS_USAGE_DATA_DIR") {
        config.data_dir = data_dir.into();
    }
    if let Ok(host) = std::env::var("AGENTS_USAGE_HOST") {
        config.host = host;
    }
    if let Some(port) = std::env::var("AGENTS_USAGE_PORT")
        .ok()
        .and_then(|value| value.parse().ok())
    {
        config.port = port;
    }
    if let Ok(timezone) = std::env::var("AGENTS_USAGE_TIMEZONE") {
        config.timezone = timezone;
    }
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--timezone" => {
                index += 1;
                if let Some(value) = args.get(index) {
                    config.timezone = value.clone();
                }
            }
            "--port" => {
                index += 1;
                if let Some(value) = args.get(index) {
                    if let Ok(port) = value.parse() {
                        config.port = port;
                    }
                }
            }
            other => {
                eprintln!("unknown argument: {other}\n\n{USAGE}");
                return ExitCode::from(2);
            }
        }
        index += 1;
    }

    let service = match usage_service::ServiceBuilder::new(config.clone()) {
        Ok(service) => service,
        Err(error) => {
            eprintln!("cannot start the service: {error}");
            return ExitCode::FAILURE;
        }
    };

    match service.start().await {
        Ok(mut running) => {
            eprintln!("usage-service listening on {}", running.origin());
            let http = match running.take_http_server() {
                Some(http) => http,
                None => {
                    eprintln!("service has no HTTP server to run");
                    return ExitCode::FAILURE;
                }
            };
            let serve_task = tokio::spawn(http.serve());
            tokio::select! {
                result = serve_task => {
                    match result {
                        Ok(Ok(())) => {}
                        Ok(Err(error)) => {
                            eprintln!("service stopped: {error}");
                            return ExitCode::FAILURE;
                        }
                        Err(error) => {
                            eprintln!("service task failed: {error}");
                            return ExitCode::FAILURE;
                        }
                    }
                }
                _ = tokio::signal::ctrl_c() => {
                    running.shutdown().await;
                }
            }
            ExitCode::SUCCESS
        }
        Err(usage_service::ServiceError::AlreadyRunning { origin, .. }) => {
            // A second launch connects to the existing service; as a CLI we just
            // report the address and exit cleanly.
            eprintln!("usage-service already running at {origin}");
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("cannot start the service: {error}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn help_text_documents_the_self_check_entry_point() {
        assert!(super::USAGE.contains("--self-check"));
    }

    #[test]
    fn help_text_documents_the_listener_options() {
        assert!(super::USAGE.contains("--timezone"));
        assert!(super::USAGE.contains("--port"));
    }
}
