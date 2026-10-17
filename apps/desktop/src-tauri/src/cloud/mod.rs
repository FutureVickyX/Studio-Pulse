//! Phase 2A: Supabase account, workspaces and time-entry synchronization (docs/supabase.md).
//!
//! Layout:
//! - [`config`]      the project URL + publishable key (build-time), validated; secret keys refused
//! - [`api`]         the remote contract ([`api::RemoteApi`]) and its types and errors
//! - [`http`]        the real Supabase implementation (Auth REST + PostgREST RPCs, blocking reqwest)
//! - [`credentials`] where the refresh token lives (Windows Credential Manager)
//! - [`account`]     sign-in/up/out, session restore and refresh, memberships, sync workspace
//! - [`ledger`]      what the sync service needs from the local database ([`ledger::SyncLedger`])
//! - [`sync`]        the background uploader: batches, idempotent results, bounded backoff
//!
//! Tokens never reach the webview: the UI calls allowlisted commands and receives
//! [`account::AccountStatus`] / [`sync::SyncOverview`] snapshots only.

pub mod account;
pub mod api;
pub mod config;
pub mod credentials;
pub mod http;
pub mod ledger;
pub mod sync;
