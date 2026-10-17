#!/usr/bin/env node
// Scan build outputs and desktop sources for Supabase secrets that must never ship.
//
//   npm run check:secrets                      apps/desktop/dist, the release exe, the NSIS
//                                              installer(s) and apps/desktop/src-tauri/src
//   npm run check:secrets -- <file|dir> ...    scan these instead
//   options: --env-path <path>   --no-allowlist   --help
//
// Exit 0: nothing found. Exit 1: findings, reported as file + kind + line/offset (the matched
// text is never printed). Exit 2: usage error or nothing to scan. What is detected, the allowlist
// and the limits are documented in scripts/supabase/secret-scan.mjs and scripts/supabase/README.md.

import process from 'node:process';

import { main } from './supabase/secret-scan.mjs';

process.exitCode = main(process.argv.slice(2));
