//! Manual verification CLI for the Win32 probes and registry matching (docs/testing.md).
//!
//! ```text
//! cargo run --example probe                 # sample once per second until Ctrl+C
//! cargo run --example probe -- --seconds 10 # ten samples, then exit
//! cargo run --example probe -- --list       # running applications and their matches
//! cargo run --example probe -- --show-path  # also print full image paths
//! ```
//!
//! Every built-in application is enabled for probing, so the output shows what the registry
//! *would* track. It prints the session state, idle seconds, the foreground image name and the
//! registry match. It never reads or prints window titles.

use std::process::ExitCode;
use std::time::{Duration, Instant};

use studio_pulse_lib::platform::{self, ProcessInfo};
use studio_pulse_lib::registry::{
    default_applications, ApplicationDefinition, MatchOutcome, Registry,
};
use studio_pulse_lib::tracker::SessionState;

const USAGE: &str = "\
Studio Pulse probe: prints what the tracker observes, once per second.

USAGE:
    probe [--seconds N] [--show-path]
    probe --list [--show-path]

OPTIONS:
    --seconds N   take N samples, then exit (default: run until Ctrl+C)
    --list        print the running applications with their registry matches, then exit
    --show-path   also print full executable paths (off by default)
    -h, --help    print this help";

#[derive(Debug, Default)]
struct Options {
    seconds: Option<u64>,
    list: bool,
    show_path: bool,
}

fn parse_args(args: impl IntoIterator<Item = String>) -> Result<Option<Options>, String> {
    let mut options = Options::default();
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--seconds" => {
                let value = args.next().ok_or("--seconds needs a value")?;
                let seconds = value
                    .parse::<u64>()
                    .map_err(|_| format!("--seconds expects a whole number, got {value:?}"))?;
                options.seconds = Some(seconds);
            }
            "--list" => options.list = true,
            "--show-path" => options.show_path = true,
            "-h" | "--help" => return Ok(None),
            other => return Err(format!("unknown argument {other:?}")),
        }
    }
    Ok(Some(options))
}

/// The built-in registry with every application enabled.
fn probing_registry() -> Registry {
    let apps = default_applications()
        .into_iter()
        .zip(0_i64..)
        .map(|(app, sort_order)| ApplicationDefinition {
            id: app.id,
            display_name: app.display_name,
            category: app.category,
            matchers: app.matchers,
            enabled: true,
            include_in_reports: true,
            built_in: true,
            sort_order,
            created_at: String::new(),
            updated_at: String::new(),
        })
        .collect();
    Registry::new(apps)
}

fn match_label(registry: &Registry, process: &ProcessInfo) -> String {
    match registry.match_process(&process.exe_name, &process.exe_path) {
        MatchOutcome::Tracked(app) => app.id.clone(),
        MatchOutcome::Disabled(app) => format!("disabled ({})", app.id),
        MatchOutcome::Unknown => "untracked".to_string(),
    }
}

fn session_label(state: SessionState) -> &'static str {
    match state {
        SessionState::Active => "active",
        SessionState::Locked => "locked",
        SessionState::ScreenSaver => "screenSaver",
        SessionState::Disconnected => "disconnected",
        SessionState::Unknown => "unknown",
    }
}

fn list(registry: &Registry, show_path: bool) {
    let apps = platform::running_applications();
    println!("{} running application(s)", apps.len());
    if show_path {
        println!("{:>7}  {:<36}  {:<28}  path", "pid", "exe", "match");
    } else {
        println!("{:>7}  {:<36}  match", "pid", "exe");
    }
    for app in &apps {
        let label = match_label(registry, app);
        if show_path {
            println!(
                "{:>7}  {:<36}  {:<28}  {}",
                app.pid, app.exe_name, label, app.exe_path
            );
        } else {
            println!("{:>7}  {:<36}  {}", app.pid, app.exe_name, label);
        }
    }
}

fn sample(registry: &Registry, seconds: Option<u64>, show_path: bool) {
    let mut probe = platform::create_probe();
    if show_path {
        println!(
            "{:<8}  {:<12}  {:>7}  {:<36}  {:<28}  path",
            "time", "session", "idle", "foreground", "match"
        );
    } else {
        println!(
            "{:<8}  {:<12}  {:>7}  {:<36}  match",
            "time", "session", "idle", "foreground"
        );
    }
    let start = Instant::now();
    let mut taken = 0_u64;
    loop {
        let session = probe.session_state();
        let idle = probe
            .idle_ms()
            .map_or_else(|| "?".to_string(), |ms| format!("{}s", ms / 1_000));
        let foreground = probe.foreground_process();
        let (exe, label, path) = match &foreground {
            Some(process) => (
                process.exe_name.as_str(),
                match_label(registry, process),
                process.exe_path.as_str(),
            ),
            None => ("-", "untracked".to_string(), "-"),
        };
        let time = chrono::Local::now().format("%H:%M:%S");
        let session = session_label(session);
        if show_path {
            println!("{time:<8}  {session:<12}  {idle:>7}  {exe:<36}  {label:<28}  {path}");
        } else {
            println!("{time:<8}  {session:<12}  {idle:>7}  {exe:<36}  {label}");
        }

        taken += 1;
        if seconds.is_some_and(|limit| taken >= limit) {
            break;
        }
        // Tick on whole seconds from the start so the output does not drift.
        let next = start + Duration::from_secs(taken);
        std::thread::sleep(next.saturating_duration_since(Instant::now()));
    }
}

fn main() -> ExitCode {
    let options = match parse_args(std::env::args().skip(1)) {
        Ok(Some(options)) => options,
        Ok(None) => {
            println!("{USAGE}");
            return ExitCode::SUCCESS;
        }
        Err(err) => {
            eprintln!("error: {err}\n\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    if !cfg!(windows) {
        eprintln!("note: Studio Pulse probes only report real data on Windows.");
    }

    let registry = probing_registry();
    if options.list {
        list(&registry, options.show_path);
    } else if options.seconds != Some(0) {
        sample(&registry, options.seconds, options.show_path);
    }
    ExitCode::SUCCESS
}
