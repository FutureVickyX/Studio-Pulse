//! Matcher evaluation: a case-insensitive `*` glob over the image file name plus an optional
//! case-insensitive path substring, and the specificity ranking used to pick the best match.

use super::{ApplicationDefinition, ProcessMatcher};

/// Specificity added by a `path_includes` constraint.
const PATH_INCLUDES_WEIGHT: u8 = 2;
/// Specificity added by an exe pattern without wildcards.
const EXACT_EXE_WEIGHT: u8 = 1;

/// A process image lowercased once, so matching a whole registry does not lowercase the same
/// strings for every matcher.
pub(super) struct NormalizedProcess {
    exe_name: Vec<char>,
    exe_path: String,
}

impl NormalizedProcess {
    pub(super) fn new(exe_name: &str, exe_path: &str) -> Self {
        Self {
            exe_name: exe_name.trim().to_lowercase().chars().collect(),
            exe_path: exe_path.to_lowercase(),
        }
    }
}

/// The most specific matcher of `app` that accepts `process`, or `None` when none does.
pub(super) fn app_specificity(
    app: &ApplicationDefinition,
    process: &NormalizedProcess,
) -> Option<u8> {
    app.matchers
        .iter()
        .filter_map(|matcher| specificity(matcher, process))
        .max()
}

/// `Some(rank)` when `matcher` accepts `process`: `path_includes` counts 2 and an exe pattern
/// without `*` counts 1, so path-qualified exact > path-qualified wildcard > exact > wildcard.
/// An empty or whitespace-only `path_includes` is treated as absent.
pub(super) fn specificity(matcher: &ProcessMatcher, process: &NormalizedProcess) -> Option<u8> {
    let pattern: Vec<char> = matcher.exe.trim().to_lowercase().chars().collect();
    if pattern.is_empty() || !wildcard_match(&pattern, &process.exe_name) {
        return None;
    }
    let mut rank = 0;
    if !pattern.contains(&'*') {
        rank += EXACT_EXE_WEIGHT;
    }
    if let Some(fragment) = path_fragment(matcher) {
        if !process.exe_path.contains(&fragment.to_lowercase()) {
            return None;
        }
        rank += PATH_INCLUDES_WEIGHT;
    }
    Some(rank)
}

/// The trimmed `path_includes`, or `None` when absent or blank.
fn path_fragment(matcher: &ProcessMatcher) -> Option<&str> {
    matcher
        .path_includes
        .as_deref()
        .map(str::trim)
        .filter(|fragment| !fragment.is_empty())
}

/// Glob match where `*` matches any run of characters (including none) and every other
/// character matches itself. Iterative with single-star backtracking: O(pattern × text) worst
/// case, no recursion, no allocation.
pub(super) fn wildcard_match(pattern: &[char], text: &[char]) -> bool {
    let (mut p, mut t) = (0, 0);
    // Position of the most recent `*` in the pattern and the text index it is currently
    // assumed to extend to.
    let mut backtrack: Option<(usize, usize)> = None;
    while t < text.len() {
        match pattern.get(p) {
            Some('*') => {
                backtrack = Some((p, t));
                p += 1;
            }
            Some(&c) if c == text[t] => {
                p += 1;
                t += 1;
            }
            _ => match backtrack {
                // Let the last `*` swallow one more character and retry from there.
                Some((star, consumed)) => {
                    p = star + 1;
                    t = consumed + 1;
                    backtrack = Some((star, consumed + 1));
                }
                None => return false,
            },
        }
    }
    pattern[p..].iter().all(|&c| c == '*')
}
