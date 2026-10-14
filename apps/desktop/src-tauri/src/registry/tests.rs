use std::collections::HashSet;

use super::matching::wildcard_match;
use super::validation::is_valid_id;
use super::*;

const REQUIRED_APPS: [&str; 21] = [
    "figma",
    "adobe-illustrator",
    "adobe-photoshop",
    "affinity-designer",
    "coreldraw",
    "inkscape",
    "adobe-after-effects",
    "adobe-premiere-pro",
    "davinci-resolve",
    "adobe-media-encoder",
    "blender",
    "cinema-4d",
    "houdini",
    "adobe-indesign",
    "adobe-audition",
    "adobe-lightroom",
    "adobe-substance-3d-painter",
    "krita",
    "gimp",
    "framer",
    "vscode",
];

const TS: &str = "2026-01-01T00:00:00.000Z";

fn definition(
    default: &DefaultApplication,
    sort_order: i64,
    enabled: bool,
) -> ApplicationDefinition {
    ApplicationDefinition {
        id: default.id.clone(),
        display_name: default.display_name.clone(),
        category: default.category,
        matchers: default.matchers.clone(),
        enabled,
        include_in_reports: true,
        built_in: true,
        sort_order,
        created_at: TS.to_string(),
        updated_at: TS.to_string(),
    }
}

/// The built-in registry with every application enabled.
fn all_enabled() -> Registry {
    Registry::new(
        default_applications()
            .iter()
            .enumerate()
            .map(|(index, app)| definition(app, index as i64, true))
            .collect(),
    )
}

/// The built-in registry as seeded on first run (`enabledByDefault`).
fn as_seeded() -> Registry {
    Registry::new(
        default_applications()
            .iter()
            .enumerate()
            .map(|(index, app)| definition(app, index as i64, app.enabled_by_default))
            .collect(),
    )
}

fn matcher(exe: &str, path_includes: Option<&str>) -> ProcessMatcher {
    ProcessMatcher {
        exe: exe.to_string(),
        path_includes: path_includes.map(str::to_string),
    }
}

fn app(id: &str, matchers: Vec<ProcessMatcher>) -> ApplicationDefinition {
    ApplicationDefinition {
        id: id.to_string(),
        display_name: id.to_string(),
        category: AppCategory::Other,
        matchers,
        enabled: true,
        include_in_reports: true,
        built_in: true,
        sort_order: 0,
        created_at: TS.to_string(),
        updated_at: TS.to_string(),
    }
}

/// The id of the application tracked for `path` (exe name taken from the path), or a marker.
fn outcome_for(registry: &Registry, path: &str) -> String {
    let exe_name = crate::platform::exe_name_from_path(path);
    match registry.match_process(exe_name, path) {
        MatchOutcome::Tracked(app) => app.id.clone(),
        MatchOutcome::Disabled(app) => format!("disabled:{}", app.id),
        MatchOutcome::Unknown => "unknown".to_string(),
    }
}

// ---- defaults ---------------------------------------------------------------------------------

#[test]
fn defaults_parse() {
    let file: DefaultApplicationsFile =
        serde_json::from_str(DEFAULT_APPLICATIONS_JSON).expect("defaults parse");
    assert_eq!(file.version, 1);
    assert!(!file.applications.is_empty());
    assert_eq!(default_applications(), file.applications);
}

#[test]
fn default_ids_are_unique_and_valid() {
    let defaults = default_applications();
    let mut ids = HashSet::new();
    for app in &defaults {
        assert!(is_valid_id(&app.id), "invalid id {:?}", app.id);
        assert!(ids.insert(app.id.as_str()), "duplicate id {:?}", app.id);
    }
}

#[test]
fn every_default_matcher_and_application_is_valid() {
    for app in default_applications() {
        for matcher in &app.matchers {
            assert_eq!(validate_matcher(matcher), Ok(()), "{}: {matcher:?}", app.id);
        }
        let input = ApplicationInput {
            id: Some(app.id.clone()),
            display_name: app.display_name.clone(),
            category: app.category,
            matchers: app.matchers.clone(),
            enabled: app.enabled_by_default,
            include_in_reports: true,
        };
        assert_eq!(validate_input(&input), Ok(()), "{}", app.id);
    }
}

#[test]
fn no_two_defaults_share_an_identical_matcher() {
    let mut seen = HashSet::new();
    for app in default_applications() {
        for matcher in &app.matchers {
            let key = (
                matcher.exe.to_lowercase(),
                matcher.path_includes.as_deref().map(str::to_lowercase),
            );
            assert!(seen.insert(key), "{} repeats {matcher:?}", app.id);
        }
    }
}

#[test]
fn required_applications_are_present() {
    let ids: HashSet<String> = default_applications()
        .into_iter()
        .map(|app| app.id)
        .collect();
    for required in REQUIRED_APPS {
        assert!(
            ids.contains(required),
            "missing default application {required}"
        );
    }
}

#[test]
fn category_strings_round_trip() {
    for app in default_applications() {
        assert_eq!(
            AppCategory::parse(app.category.as_str()),
            Some(app.category)
        );
    }
    assert_eq!(AppCategory::parse("3d"), Some(AppCategory::ThreeD));
    assert_eq!(AppCategory::parse("games"), None);
}

// ---- wildcard and matcher ---------------------------------------------------------------------

fn glob(pattern: &str, text: &str) -> bool {
    let pattern: Vec<char> = pattern.chars().collect();
    let text: Vec<char> = text.chars().collect();
    wildcard_match(&pattern, &text)
}

#[test]
fn wildcard_semantics() {
    let cases = [
        ("gimp-*.exe", "gimp-2.10.exe", true),
        ("gimp-*.exe", "gimp-.exe", true),
        ("gimp-*.exe", "gimp.exe", false),
        ("*", "", true),
        ("*", "anything", true),
        ("", "", true),
        ("", "a", false),
        ("a*b*c", "abc", true),
        ("a*b*c", "aXbYc", true),
        ("a*b*c", "aXbY", false),
        ("a*b", "abab", true),
        ("*a*a*a*a", "aaaa", true),
        ("*a*a*a*a", "aaa", false),
        ("a**b", "ab", true),
        ("abc", "abcd", false),
        ("abcd", "abc", false),
        ("?.exe", "a.exe", false), // only `*` is special
        ("a.exe", "a.exe", true),
        ("a.exe", "aXexe", false), // `.` is literal
        ("[ab].exe", "a.exe", false),
    ];
    for (pattern, text, expected) in cases {
        assert_eq!(glob(pattern, text), expected, "{pattern:?} vs {text:?}");
    }
}

#[test]
fn wildcard_is_linear_enough_on_pathological_input() {
    let text = "a".repeat(260);
    assert!(!glob("*a*a*a*b.exe", &text));
}

#[test]
fn matcher_is_case_insensitive() {
    let photoshop = matcher("Photoshop.exe", None);
    assert!(matcher_matches(
        &photoshop,
        "PHOTOSHOP.EXE",
        r"C:\PS\PHOTOSHOP.EXE"
    ));
    assert!(matcher_matches(
        &photoshop,
        "photoshop.exe",
        r"c:\ps\photoshop.exe"
    ));
    assert!(!matcher_matches(
        &photoshop,
        "Photoshop Elements.exe",
        r"C:\Photoshop Elements.exe"
    ));
    assert!(!matcher_matches(
        &photoshop,
        "Photoshop.exe.bak",
        r"C:\Photoshop.exe.bak"
    ));
}

#[test]
fn matcher_lowercases_unicode() {
    let m = matcher("ÉDITEUR.exe", None);
    assert!(matcher_matches(&m, "éditeur.EXE", r"C:\éditeur.exe"));
    let m = matcher("Studio*.exe", Some("ÜBER"));
    assert!(matcher_matches(
        &m,
        "studio Pro.exe",
        r"C:\Programme\über\studio Pro.exe"
    ));
    assert!(!matcher_matches(
        &m,
        "studio Pro.exe",
        r"C:\Programme\uber\studio Pro.exe"
    ));
}

#[test]
fn matcher_compares_the_file_name_not_the_path() {
    let m = matcher("Figma.exe", None);
    assert!(!matcher_matches(
        &m,
        "Updater.exe",
        r"C:\Figma.exe\Updater.exe"
    ));
    let m = matcher("*Figma*.exe", None);
    assert!(!matcher_matches(&m, "Updater.exe", r"C:\Figma\Updater.exe"));
}

#[test]
fn path_includes_requires_a_path_substring() {
    let m = matcher("Designer.exe", Some("Affinity"));
    assert!(matcher_matches(
        &m,
        "Designer.exe",
        r"C:\Program Files\Affinity\Designer\Designer.exe"
    ));
    assert!(matcher_matches(
        &m,
        "designer.exe",
        r"c:\program files\AFFINITY\designer.exe"
    ));
    assert!(!matcher_matches(
        &m,
        "Designer.exe",
        r"C:\Tools\Designer.exe"
    ));
    // A blank fragment behaves as if absent.
    let blank = matcher("Designer.exe", Some("  "));
    assert!(matcher_matches(
        &blank,
        "Designer.exe",
        r"C:\Tools\Designer.exe"
    ));
}

// ---- registry matching on real image paths ----------------------------------------------------

#[test]
fn real_world_paths_match_the_expected_application() {
    let registry = all_enabled();
    let cases = [
        (
            r"C:\Users\x\AppData\Local\Figma\app-125.4.7\Figma.exe",
            "figma",
        ),
        (
            r"C:\Users\x\AppData\Local\FigmaBeta\app-125.5.0\Figma Beta.exe",
            "figma",
        ),
        (
            r"C:\Program Files\Adobe\Adobe After Effects 2025\Support Files\AfterFX.exe",
            "adobe-after-effects",
        ),
        (
            r"C:\Program Files\Adobe\Adobe After Effects (Beta)\Support Files\AfterFX (Beta).exe",
            "adobe-after-effects",
        ),
        (
            r"C:\Program Files\Blender Foundation\Blender 5.2\blender.exe",
            "blender",
        ),
        (r"C:\Program Files\GIMP 2\bin\gimp-2.10.exe", "gimp"),
        (r"C:\Program Files\GIMP 3\bin\gimp-3.0.exe", "gimp"),
        (r"C:\Program Files\GIMP 3\bin\gimp.exe", "gimp"),
        (
            r"C:\Program Files\Affinity\Designer 2\Designer.exe",
            "affinity-designer",
        ),
        (
            r"C:\Program Files\Affinity\Affinity Designer 2\Affinity Designer 2.exe",
            "affinity-designer",
        ),
        (r"C:\Tools\Designer.exe", "unknown"),
        (
            r"C:\Users\x\AppData\Local\Programs\Microsoft VS Code\Code.exe",
            "vscode",
        ),
        (r"C:\Program Files\Microsoft VS Code\Code.exe", "vscode"),
        (r"C:\Games\Code.exe", "unknown"),
        (
            r"C:\Program Files\Adobe\Adobe Photoshop 2025\Photoshop.exe",
            "adobe-photoshop",
        ),
        (r"C:\PROGRAM FILES\ADOBE\PHOTOSHOP.EXE", "adobe-photoshop"),
        (
            r"C:\Program Files\Adobe\Adobe Premiere Pro 2025\Adobe Premiere Pro.exe",
            "adobe-premiere-pro",
        ),
        (
            r"C:\Program Files\Blackmagic Design\DaVinci Resolve\Resolve.exe",
            "davinci-resolve",
        ),
        (
            r"C:\Program Files\Side Effects Software\Houdini 21.0\bin\houdinifx.exe",
            "houdini",
        ),
        (
            r"C:\Program Files\Maxon Cinema 4D 2025\Cinema 4D.exe",
            "cinema-4d",
        ),
        (r"C:\Program Files\Krita (x64)\bin\krita.exe", "krita"),
        (r"C:\Windows\explorer.exe", "unknown"),
        (r"C:\Program Files\Mozilla Firefox\firefox.exe", "unknown"),
        ("", "unknown"),
    ];
    for (path, expected) in cases {
        assert_eq!(outcome_for(&registry, path), expected, "{path}");
    }
}

#[test]
fn vscode_is_disabled_by_default_and_does_not_fall_through() {
    let registry = as_seeded();
    assert_eq!(
        outcome_for(&registry, r"C:\Program Files\Microsoft VS Code\Code.exe"),
        "disabled:vscode"
    );
    let process = crate::platform::ProcessInfo {
        pid: 42,
        exe_name: "Code.exe".to_string(),
        exe_path: r"C:\Program Files\Microsoft VS Code\Code.exe".to_string(),
    };
    assert_eq!(registry.tracked_app(&process), None);
}

#[test]
fn tracked_app_reports_id_and_display_name() {
    let registry = as_seeded();
    let process = crate::platform::ProcessInfo {
        pid: 7,
        exe_name: "AfterFX.exe".to_string(),
        exe_path: r"C:\Program Files\Adobe\Adobe After Effects 2025\Support Files\AfterFX.exe"
            .to_string(),
    };
    let tracked = registry
        .tracked_app(&process)
        .expect("after effects is tracked");
    assert_eq!(tracked.application_id, "adobe-after-effects");
    assert_eq!(tracked.application_name, "Adobe After Effects");
}

#[test]
fn disabled_best_match_does_not_fall_through_to_a_weaker_enabled_match() {
    let mut specific = app("affinity", vec![matcher("Designer.exe", Some("Affinity"))]);
    specific.enabled = false;
    let generic = app("any-designer", vec![matcher("*Designer*.exe", None)]);
    let registry = Registry::new(vec![generic, specific]);

    let path = r"C:\Program Files\Affinity\Designer 2\Designer.exe";
    assert_eq!(outcome_for(&registry, path), "disabled:affinity");
    // Elsewhere, only the generic application matches.
    assert_eq!(
        outcome_for(&registry, r"C:\Tools\Designer.exe"),
        "any-designer"
    );
}

#[test]
fn path_includes_beats_exe_only() {
    let exact_exe = app("plain", vec![matcher("Designer.exe", None)]);
    let with_path = app("pathed", vec![matcher("Designer*.exe", Some("Affinity"))]);
    let registry = Registry::new(vec![exact_exe, with_path]);
    // A wildcard qualified by a path (2) outranks an exact exe without one (1).
    assert_eq!(
        outcome_for(&registry, r"C:\Affinity\Designer.exe"),
        "pathed"
    );
    assert_eq!(outcome_for(&registry, r"C:\Other\Designer.exe"), "plain");
}

#[test]
fn exact_exe_beats_wildcard() {
    let wildcard = app("wild", vec![matcher("After*.exe", None)]);
    let exact = app("exact", vec![matcher("AfterFX.exe", None)]);
    let registry = Registry::new(vec![wildcard, exact]);
    assert_eq!(outcome_for(&registry, r"C:\AE\AfterFX.exe"), "exact");
    assert_eq!(outcome_for(&registry, r"C:\AE\AfterFX (Beta).exe"), "wild");
}

#[test]
fn an_application_is_ranked_by_its_most_specific_matcher() {
    // `multi` has a weak wildcard and a strong path-qualified matcher; `single` has an exact exe.
    let multi = app(
        "multi",
        vec![matcher("T*.exe", None), matcher("Tool.exe", Some("Vendor"))],
    );
    let single = app("single", vec![matcher("Tool.exe", None)]);
    let registry = Registry::new(vec![single, multi]);
    assert_eq!(outcome_for(&registry, r"C:\Vendor\Tool.exe"), "multi");
    assert_eq!(outcome_for(&registry, r"C:\Other\Tool.exe"), "single");
}

#[test]
fn custom_application_beats_built_in_on_equal_specificity() {
    let built_in = app("adobe-photoshop", vec![matcher("Photoshop.exe", None)]);
    let mut custom = app("custom-1234abcd", vec![matcher("photoshop.exe", None)]);
    custom.built_in = false;
    custom.sort_order = 999;
    let registry = Registry::new(vec![built_in.clone(), custom.clone()]);
    assert_eq!(
        outcome_for(&registry, r"C:\PS\Photoshop.exe"),
        "custom-1234abcd"
    );
    // Order in the list does not matter.
    let registry = Registry::new(vec![custom, built_in]);
    assert_eq!(
        outcome_for(&registry, r"C:\PS\Photoshop.exe"),
        "custom-1234abcd"
    );
}

#[test]
fn ties_fall_back_to_sort_order_then_id() {
    let mut late = app("a-late", vec![matcher("Tool.exe", None)]);
    late.sort_order = 5;
    let mut early = app("z-early", vec![matcher("Tool.exe", None)]);
    early.sort_order = 1;
    let registry = Registry::new(vec![late.clone(), early.clone()]);
    assert_eq!(outcome_for(&registry, r"C:\Tool.exe"), "z-early");

    late.sort_order = 1;
    let registry = Registry::new(vec![early, late]);
    assert_eq!(outcome_for(&registry, r"C:\Tool.exe"), "a-late");
}

#[test]
fn empty_registry_matches_nothing() {
    let registry = Registry::default();
    assert_eq!(
        registry.match_process("Figma.exe", r"C:\Figma.exe"),
        MatchOutcome::Unknown
    );
    assert!(registry.apps().is_empty());
    assert!(registry.get("figma").is_none());
    assert!(all_enabled().get("figma").is_some());
}

// ---- validation -------------------------------------------------------------------------------

#[test]
fn matcher_validation_table() {
    let long_name = format!("{}.exe", "a".repeat(256)); // 260
    let too_long_name = format!("{}.exe", "a".repeat(257)); // 261
    let long_path = "p".repeat(260);
    let too_long_path = "p".repeat(261);
    let cases: Vec<(&str, Option<&str>, bool)> = vec![
        ("Photoshop.exe", None, true),
        ("  Photoshop.exe  ", None, true),
        ("PHOTOSHOP.EXE", None, true),
        ("Figma Beta.exe", None, true),
        ("gimp-*.exe", None, true),
        ("*a*b*c*.exe", None, true),    // exactly 4 wildcards
        ("*a*b*c*d*.exe", None, false), // 5 wildcards
        ("Designer.exe", Some("Affinity"), true),
        ("Designer.exe", Some("  Affinity  "), true),
        ("Designer.exe", Some(""), false),
        ("Designer.exe", Some("   "), false),
        ("Designer.exe", Some(long_path.as_str()), true),
        ("Designer.exe", Some(too_long_path.as_str()), false),
        (long_name.as_str(), None, true),
        (too_long_name.as_str(), None, false),
        ("", None, false),
        ("   ", None, false),
        ("Photoshop", None, false),
        ("Photoshop.exe.bak", None, false),
        ("Photoshop.com", None, false),
        (".exe", None, false),
        ("*.exe", None, false),
        ("**.exe", None, false),
        ("*.EXE", None, false),
        (r"C:\Apps\Photoshop.exe", None, false),
        (r"Adobe\Photoshop.exe", None, false),
        ("Adobe/Photoshop.exe", None, false),
        ("C:Photoshop.exe", None, false),
        ("é.exe", None, true),
    ];
    for (exe, path_includes, valid) in cases {
        let result = validate_matcher(&matcher(exe, path_includes));
        assert_eq!(
            result.is_ok(),
            valid,
            "{exe:?} / {path_includes:?}: {result:?}"
        );
        if let Err(message) = result {
            assert!(!message.is_empty());
        }
    }
}

fn input(id: Option<&str>, display_name: &str, matchers: Vec<ProcessMatcher>) -> ApplicationInput {
    ApplicationInput {
        id: id.map(str::to_string),
        display_name: display_name.to_string(),
        category: AppCategory::Design,
        matchers,
        enabled: true,
        include_in_reports: true,
    }
}

#[test]
fn input_validation_table() {
    let ok = || vec![matcher("Tool.exe", None)];
    let sixteen: Vec<ProcessMatcher> = (0..16)
        .map(|i| matcher(&format!("t{i}.exe"), None))
        .collect();
    let seventeen: Vec<ProcessMatcher> = (0..17)
        .map(|i| matcher(&format!("t{i}.exe"), None))
        .collect();
    let max_id = format!("a{}", "b".repeat(63)); // 64
    let long_id = format!("a{}", "b".repeat(64)); // 65
    let name_80 = "n".repeat(80);
    let name_81 = "n".repeat(81);
    let cases: Vec<(ApplicationInput, bool)> = vec![
        (input(None, "Tool", ok()), true),
        (input(Some("custom-1a2b3c4d"), "Tool", ok()), true),
        (input(Some("figma"), "Figma", ok()), true),
        (input(Some("3d-tool"), "3D", ok()), true),
        (input(Some("ab"), "Tool", ok()), true),
        (input(Some(max_id.as_str()), "Tool", ok()), true),
        (input(Some(long_id.as_str()), "Tool", ok()), false),
        (input(Some("a"), "Tool", ok()), false),
        (input(Some(""), "Tool", ok()), false),
        (input(Some("-figma"), "Tool", ok()), false),
        (input(Some("Figma"), "Tool", ok()), false),
        (input(Some("fig_ma"), "Tool", ok()), false),
        (input(Some("fig ma"), "Tool", ok()), false),
        (input(Some("figmä"), "Tool", ok()), false),
        (input(None, "", ok()), false),
        (input(None, "   ", ok()), false),
        (input(None, "  Tool  ", ok()), true),
        (input(None, &name_80, ok()), true),
        (input(None, &name_81, ok()), false),
        (input(None, "Tool", Vec::new()), false),
        (input(None, "Tool", sixteen), true),
        (input(None, "Tool", seventeen), false),
        (
            input(
                None,
                "Tool",
                vec![matcher("Tool.exe", None), matcher("*.exe", None)],
            ),
            false,
        ),
    ];
    for (input, valid) in cases {
        let result = validate_input(&input);
        assert_eq!(result.is_ok(), valid, "{input:?}: {result:?}");
    }
}

#[test]
fn input_errors_name_the_offending_matcher() {
    let err = validate_input(&input(
        None,
        "Tool",
        vec![matcher("Tool.exe", None), matcher("Tool", None)],
    ))
    .expect_err("second matcher is invalid");
    assert!(err.starts_with("Executable 2:"), "{err}");
}
