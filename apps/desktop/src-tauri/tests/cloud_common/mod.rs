//! In-memory fakes shared by the `cloud_*` integration tests: a ledger with the store's outbox
//! rules ([`FakeLedger`]), a Supabase stand-in with failure injection ([`FakeRemote`]), a
//! controllable clock and a [`World`] that wires them to an [`AccountManager`].
//!
//! Nothing here touches the network, the Windows Credential Manager or the real database.

#![allow(dead_code)]

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use studio_pulse_lib::cloud::account::AccountManager;
use studio_pulse_lib::cloud::api::{
    AuthSession, AuthUser, EntryOutcome, EntryResult, InvitationCreated, RemoteApi, RemoteError,
    RemoteTimeEntry, SignUpOutcome, TimeEntryVisibility, WorkspaceRole, WorkspaceSummary,
};
use studio_pulse_lib::cloud::config::SupabaseConfig;
use studio_pulse_lib::cloud::credentials::{CredentialStore, MemoryCredentialStore, StoredSession};
use studio_pulse_lib::cloud::ledger::{LedgerError, OutboxCounts, PendingEntry, SyncLedger};
use studio_pulse_lib::cloud::sync::{SyncCore, SyncSettings};

/// 2026-10-13T09:15:00.000Z.
pub const T0: i64 = 1_791_882_900_000;
pub const MINUTE: i64 = 60_000;
/// Lifetime of access tokens issued by [`FakeRemote`].
pub const TOKEN_TTL_MS: i64 = 3_600_000;

pub const EMAIL: &str = "ada@example.com";
pub const PASSWORD: &str = "correct horse battery";
pub const DEVICE_ID: &str = "0190a7f0-0000-7000-8000-0000000000d1";
pub const WS_A: &str = "0190a7f0-0000-7000-8000-00000000aaaa";
pub const WS_B: &str = "0190a7f0-0000-7000-8000-00000000bbbb";

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|p| p.into_inner())
}

// ---- clock ----------------------------------------------------------------------------------

#[derive(Clone)]
pub struct TestClock(Arc<AtomicI64>);

impl TestClock {
    pub fn new(start: i64) -> Self {
        Self(Arc::new(AtomicI64::new(start)))
    }
    pub fn now(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
    pub fn advance(&self, ms: i64) {
        self.0.fetch_add(ms, Ordering::SeqCst);
    }
    pub fn boxed_sync(&self) -> Box<dyn Fn() -> i64 + Send + Sync> {
        let c = self.clone();
        Box::new(move || c.now())
    }
    pub fn boxed(&self) -> Box<dyn Fn() -> i64 + Send> {
        let c = self.clone();
        Box::new(move || c.now())
    }
}

// ---- ledger ---------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RowStatus {
    Pending,
    Synced,
    Failed,
}

#[derive(Debug, Clone)]
pub struct Row {
    pub entry: PendingEntry,
    pub user_id: Option<String>,
    pub closed: bool,
    pub status: RowStatus,
    pub workspace_id: Option<String>,
    pub synced_at_ms: Option<i64>,
    pub attempts: u32,
    pub last_error: Option<String>,
}

#[derive(Default)]
pub struct LedgerState {
    pub rows: Vec<Row>,
    pub account_user: Option<String>,
    pub sync_workspace: Option<String>,
    pub last_success: Option<i64>,
    next_minute: i64,
}

/// The store's outbox rules, in memory (see `cloud::ledger` for the contract).
#[derive(Default)]
pub struct FakeLedger {
    pub state: Mutex<LedgerState>,
    /// `pending_entries` panics while set (a defect inside a pass).
    pub panic_on_read: AtomicBool,
    /// `mark_synced` fails while set (a local write error after the server committed).
    pub fail_mark_synced: AtomicBool,
    /// `mark_synced` claims success but changes nothing while set (a write that did not stick).
    pub ignore_mark_synced: AtomicBool,
    /// `set_account_user` fails while set (the local database refuses the write).
    pub fail_set_account_user: AtomicBool,
}

impl FakeLedger {
    pub fn state(&self) -> MutexGuard<'_, LedgerState> {
        lock(&self.state)
    }

    /// Record `count` closed intervals, stamped with the current account (as the store does when
    /// it first writes a row). Returns their ids, oldest first.
    pub fn record(&self, count: usize) -> Vec<String> {
        let owner = self.state().account_user.clone();
        self.record_for(owner.as_deref(), count)
    }

    /// Record `count` closed intervals owned by `user_id` (`None` = unowned).
    pub fn record_for(&self, user_id: Option<&str>, count: usize) -> Vec<String> {
        let mut state = self.state();
        let mut ids = Vec::with_capacity(count);
        for _ in 0..count {
            let minute = state.next_minute;
            state.next_minute += 1;
            let entry = sample_entry(minute);
            ids.push(entry.id.clone());
            state.rows.push(Row {
                entry,
                user_id: user_id.map(str::to_owned),
                closed: true,
                status: RowStatus::Pending,
                workspace_id: None,
                synced_at_ms: None,
                attempts: 0,
                last_error: None,
            });
        }
        ids
    }

    /// An open (still running) interval owned by the current account.
    pub fn record_open(&self) -> String {
        let ids = self.record(1);
        let mut state = self.state();
        let row = state.rows.last_mut().unwrap();
        row.closed = false;
        ids[0].clone()
    }

    pub fn row(&self, id: &str) -> Row {
        self.state()
            .rows
            .iter()
            .find(|r| r.entry.id == id)
            .cloned()
            .unwrap_or_else(|| panic!("no row {id}"))
    }

    pub fn status_of(&self, id: &str) -> RowStatus {
        self.row(id).status
    }

    pub fn ids_with(&self, status: RowStatus) -> Vec<String> {
        self.state()
            .rows
            .iter()
            .filter(|r| r.status == status)
            .map(|r| r.entry.id.clone())
            .collect()
    }

    pub fn row_count(&self) -> usize {
        self.state().rows.len()
    }

    pub fn snapshot(&self) -> Vec<(String, Option<String>, RowStatus)> {
        self.state()
            .rows
            .iter()
            .map(|r| (r.entry.id.clone(), r.user_id.clone(), r.status))
            .collect()
    }
}

/// A plausible closed active interval of one minute, `minute` minutes after [`T0`].
pub fn sample_entry(minute: i64) -> PendingEntry {
    let started = T0 + minute * MINUTE;
    PendingEntry {
        id: uuid::Uuid::now_v7().to_string(),
        device_id: DEVICE_ID.into(),
        application_id: "figma".into(),
        application_name: "Figma".into(),
        kind: "active".into(),
        started_at_ms: started,
        ended_at_ms: started + MINUTE,
        active_ms: MINUTE,
        idle_ms: 0,
        end_reason: "appSwitch".into(),
        project_id: None,
        task_id: None,
        revision: 1,
        created_at_ms: started + MINUTE + 5,
    }
}

impl SyncLedger for FakeLedger {
    fn set_account_user(&self, user_id: Option<&str>) -> Result<(), LedgerError> {
        if self.fail_set_account_user.load(Ordering::SeqCst) {
            return Err(LedgerError("database is locked".into()));
        }
        self.state().account_user = user_id.map(str::to_owned);
        Ok(())
    }

    fn account_user(&self) -> Result<Option<String>, LedgerError> {
        Ok(self.state().account_user.clone())
    }

    fn sync_workspace(&self) -> Result<Option<String>, LedgerError> {
        Ok(self.state().sync_workspace.clone())
    }

    fn set_sync_workspace(&self, workspace_id: Option<&str>) -> Result<(), LedgerError> {
        self.state().sync_workspace = workspace_id.map(str::to_owned);
        Ok(())
    }

    fn pending_entries(
        &self,
        user_id: &str,
        limit: usize,
    ) -> Result<Vec<PendingEntry>, LedgerError> {
        assert!(
            !self.panic_on_read.load(Ordering::SeqCst),
            "injected ledger panic"
        );
        let state = self.state();
        let mut rows: Vec<&Row> = state
            .rows
            .iter()
            .filter(|r| {
                r.closed && r.status == RowStatus::Pending && r.user_id.as_deref() == Some(user_id)
            })
            .collect();
        rows.sort_by(|a, b| {
            (a.entry.started_at_ms, &a.entry.id).cmp(&(b.entry.started_at_ms, &b.entry.id))
        });
        Ok(rows
            .into_iter()
            .take(limit)
            .map(|r| r.entry.clone())
            .collect())
    }

    fn outbox_counts(&self, user_id: Option<&str>) -> Result<OutboxCounts, LedgerError> {
        let state = self.state();
        let pending_closed = |r: &&Row| r.closed && r.status == RowStatus::Pending;
        Ok(OutboxCounts {
            pending: match user_id {
                Some(user) => state
                    .rows
                    .iter()
                    .filter(pending_closed)
                    .filter(|r| r.user_id.as_deref() == Some(user))
                    .count() as u64,
                None => 0,
            },
            unclaimed: state
                .rows
                .iter()
                .filter(pending_closed)
                .filter(|r| r.user_id.is_none())
                .count() as u64,
            rejected: state
                .rows
                .iter()
                .filter(|r| r.status == RowStatus::Failed)
                .count() as u64,
        })
    }

    fn mark_synced(
        &self,
        ids: &[String],
        workspace_id: &str,
        at_ms: i64,
    ) -> Result<usize, LedgerError> {
        if self.fail_mark_synced.load(Ordering::SeqCst) {
            return Err(LedgerError("disk I/O error".into()));
        }
        if self.ignore_mark_synced.load(Ordering::SeqCst) {
            return Ok(ids.len());
        }
        let mut state = self.state();
        let mut updated = 0;
        for row in state.rows.iter_mut() {
            if row.closed && row.status == RowStatus::Pending && ids.contains(&row.entry.id) {
                row.status = RowStatus::Synced;
                row.workspace_id = Some(workspace_id.to_owned());
                row.synced_at_ms = Some(at_ms);
                updated += 1;
            }
        }
        Ok(updated)
    }

    fn mark_rejected(&self, rejections: &[(String, String)]) -> Result<usize, LedgerError> {
        let mut state = self.state();
        let mut updated = 0;
        for (id, reason) in rejections {
            if let Some(row) = state
                .rows
                .iter_mut()
                .find(|r| &r.entry.id == id && r.closed && r.status == RowStatus::Pending)
            {
                row.status = RowStatus::Failed;
                row.last_error = Some(reason.clone());
                updated += 1;
            }
        }
        Ok(updated)
    }

    fn existing_ids(&self, ids: &[String]) -> Result<Vec<String>, LedgerError> {
        let state = self.state();
        Ok(ids
            .iter()
            .filter(|id| state.rows.iter().any(|row| &row.entry.id == *id))
            .cloned()
            .collect())
    }

    fn record_attempt_failure(&self, ids: &[String], error: &str) -> Result<(), LedgerError> {
        let mut state = self.state();
        for row in state.rows.iter_mut() {
            if ids.contains(&row.entry.id) && row.status == RowStatus::Pending {
                row.attempts += 1;
                row.last_error = Some(error.to_owned());
            }
        }
        Ok(())
    }

    fn claim_unowned(&self, user_id: &str) -> Result<usize, LedgerError> {
        let mut state = self.state();
        let mut claimed = 0;
        for row in state.rows.iter_mut().filter(|r| r.user_id.is_none()) {
            row.user_id = Some(user_id.to_owned());
            claimed += 1;
        }
        Ok(claimed)
    }

    fn last_sync_success(&self) -> Result<Option<i64>, LedgerError> {
        Ok(self.state().last_success)
    }

    fn set_last_sync_success(&self, at_ms: i64) -> Result<(), LedgerError> {
        self.state().last_success = Some(at_ms);
        Ok(())
    }
}

// ---- remote ---------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Call {
    SignIn {
        email: String,
    },
    SignUp {
        email: String,
        display_name: String,
    },
    Refresh,
    SignOut {
        access_token: String,
    },
    MyWorkspaces,
    CreateWorkspace {
        name: String,
    },
    AcceptInvitation {
        token: String,
    },
    CreateInvitation {
        workspace_id: String,
        email: String,
        role: WorkspaceRole,
    },
    Sync {
        access_token: String,
        workspace_id: String,
        ids: Vec<String>,
        thread: Option<String>,
    },
    DeleteEntries {
        ids: Vec<String>,
    },
}

#[derive(Debug, Clone)]
pub struct FakeUser {
    pub id: String,
    pub email: String,
    pub password: String,
    pub display_name: Option<String>,
    pub confirmed: bool,
}

#[derive(Debug, Clone)]
pub struct ServerEntry {
    pub user_id: String,
    pub workspace_id: String,
    pub entry: RemoteTimeEntry,
}

#[derive(Default)]
pub struct RemoteState {
    pub users: Vec<FakeUser>,
    /// Valid refresh tokens → user id. Using one removes it (rotation).
    pub refresh_tokens: HashMap<String, String>,
    /// Valid access tokens → (user id, expires at).
    pub access_tokens: HashMap<String, (String, i64)>,
    pub token_counter: u64,
    /// Active memberships per user.
    pub memberships: HashMap<String, Vec<WorkspaceSummary>>,
    /// `public.time_entries`, keyed by id (the primary key: a second insert is impossible).
    pub entries: HashMap<String, ServerEntry>,
    /// Every insert, in order (a duplicate id here would be a duplicate row).
    pub inserts: Vec<String>,
    /// Invitation tokens → (workspace id, workspace name, role).
    pub invitations: HashMap<String, (String, String, WorkspaceRole)>,

    // failure injection
    /// Returned (in order) by `sync_time_entries` before doing anything.
    pub sync_failures: VecDeque<RemoteError>,
    /// This many `sync_time_entries` calls commit server-side, then "lose" the response.
    pub lost_responses: u32,
    /// Ids the server rejects (with this detail).
    pub reject_ids: HashMap<String, String>,
    /// Ids the server neither stores nor mentions in its answer.
    pub omit_ids: HashSet<String>,
    /// Returned (in order) by `refresh_session` before doing anything.
    pub refresh_failures: VecDeque<RemoteError>,
    /// Returned (in order) by `sign_in_with_password` before doing anything.
    pub sign_in_failures: VecDeque<RemoteError>,
    /// Returned (in order) by `my_workspaces` before doing anything.
    pub workspaces_failures: VecDeque<RemoteError>,
    /// Returned (in order) by `delete_time_entries` before doing anything.
    pub delete_failures: VecDeque<RemoteError>,
    /// Sign-up answers without a session (email confirmation on).
    pub require_confirmation: bool,

    pub calls: Vec<Call>,
}

/// A Supabase stand-in: Auth with rotating refresh tokens, memberships, and the idempotent
/// `sync_time_entries` semantics of `supabase/migrations/*_time_entries.sql`.
pub struct FakeRemote {
    pub state: Mutex<RemoteState>,
    clock: TestClock,
}

impl FakeRemote {
    pub fn new(clock: TestClock) -> Self {
        Self {
            state: Mutex::new(RemoteState::default()),
            clock,
        }
    }

    pub fn state(&self) -> MutexGuard<'_, RemoteState> {
        lock(&self.state)
    }

    pub fn add_user(&self, email: &str, password: &str, display_name: Option<&str>) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        self.state().users.push(FakeUser {
            id: id.clone(),
            email: email.into(),
            password: password.into(),
            display_name: display_name.map(str::to_owned),
            confirmed: true,
        });
        id
    }

    pub fn add_membership(
        &self,
        user_id: &str,
        workspace_id: &str,
        name: &str,
        role: WorkspaceRole,
    ) {
        self.state()
            .memberships
            .entry(user_id.into())
            .or_default()
            .push(WorkspaceSummary {
                id: workspace_id.into(),
                name: name.into(),
                role,
                time_entry_visibility: TimeEntryVisibility::Private,
            });
    }

    pub fn remove_membership(&self, user_id: &str, workspace_id: &str) {
        if let Some(list) = self.state().memberships.get_mut(user_id) {
            list.retain(|w| w.id != workspace_id);
        }
    }

    /// Issue a session directly (as if the user had signed in elsewhere).
    pub fn issue_session(&self, user_id: &str) -> AuthSession {
        let mut state = self.state();
        Self::issue(&mut state, user_id, self.clock.now())
    }

    fn issue(state: &mut RemoteState, user_id: &str, now: i64) -> AuthSession {
        state.token_counter += 1;
        let n = state.token_counter;
        let access_token = format!("access-{n}");
        let refresh_token = format!("refresh-{n}");
        let expires_at_ms = now + TOKEN_TTL_MS;
        state
            .access_tokens
            .insert(access_token.clone(), (user_id.into(), expires_at_ms));
        state
            .refresh_tokens
            .insert(refresh_token.clone(), user_id.into());
        let user = state.users.iter().find(|u| u.id == user_id).cloned();
        AuthSession {
            access_token,
            refresh_token,
            expires_at_ms,
            user: AuthUser {
                id: user_id.into(),
                email: user.as_ref().map(|u| u.email.clone()),
                display_name: user.and_then(|u| u.display_name),
            },
        }
    }

    /// The server forgets every access token (they now answer 401), refresh tokens still work.
    pub fn invalidate_access_tokens(&self) {
        self.state().access_tokens.clear();
    }

    /// The server revokes every session (refresh tokens rejected too).
    pub fn revoke_all_sessions(&self) {
        let mut state = self.state();
        state.access_tokens.clear();
        state.refresh_tokens.clear();
    }

    pub fn calls(&self) -> Vec<Call> {
        self.state().calls.clone()
    }

    pub fn sync_calls(&self) -> Vec<Call> {
        self.calls()
            .into_iter()
            .filter(|c| matches!(c, Call::Sync { .. }))
            .collect()
    }

    pub fn sync_batches(&self) -> Vec<Vec<String>> {
        self.sync_calls()
            .into_iter()
            .map(|c| match c {
                Call::Sync { ids, .. } => ids,
                _ => unreachable!(),
            })
            .collect()
    }

    pub fn refresh_calls(&self) -> usize {
        self.calls().iter().filter(|c| **c == Call::Refresh).count()
    }

    pub fn entry_ids(&self) -> HashSet<String> {
        self.state().entries.keys().cloned().collect()
    }

    pub fn inserts(&self) -> Vec<String> {
        self.state().inserts.clone()
    }

    pub fn valid_refresh_tokens(&self) -> HashSet<String> {
        self.state().refresh_tokens.keys().cloned().collect()
    }

    fn user_for_access(state: &RemoteState, token: &str, now: i64) -> Result<String, RemoteError> {
        match state.access_tokens.get(token) {
            Some((user, expires)) if *expires > now => Ok(user.clone()),
            _ => Err(RemoteError::Unauthorized),
        }
    }
}

impl RemoteApi for FakeRemote {
    fn sign_in_with_password(
        &self,
        email: &str,
        password: &str,
    ) -> Result<AuthSession, RemoteError> {
        let now = self.clock.now();
        let mut state = self.state();
        state.calls.push(Call::SignIn {
            email: email.into(),
        });
        if let Some(err) = state.sign_in_failures.pop_front() {
            return Err(err);
        }
        let user = state
            .users
            .iter()
            .find(|u| u.email == email && u.password == password)
            .cloned()
            .ok_or(RemoteError::InvalidCredentials)?;
        if !user.confirmed {
            return Err(RemoteError::EmailNotConfirmed);
        }
        Ok(Self::issue(&mut state, &user.id, now))
    }

    fn sign_up(
        &self,
        email: &str,
        password: &str,
        display_name: &str,
    ) -> Result<SignUpOutcome, RemoteError> {
        let now = self.clock.now();
        let mut state = self.state();
        state.calls.push(Call::SignUp {
            email: email.into(),
            display_name: display_name.into(),
        });
        if state.users.iter().any(|u| u.email == email) {
            return Err(RemoteError::Rejected(
                "An account with this email address already exists. Sign in instead.".into(),
            ));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let confirmed = !state.require_confirmation;
        state.users.push(FakeUser {
            id: id.clone(),
            email: email.into(),
            password: password.into(),
            display_name: Some(display_name.into()),
            confirmed,
        });
        if confirmed {
            Ok(SignUpOutcome::SignedIn(Self::issue(&mut state, &id, now)))
        } else {
            Ok(SignUpOutcome::ConfirmationRequired)
        }
    }

    fn refresh_session(&self, refresh_token: &str) -> Result<AuthSession, RemoteError> {
        let now = self.clock.now();
        let mut state = self.state();
        state.calls.push(Call::Refresh);
        if let Some(err) = state.refresh_failures.pop_front() {
            return Err(err);
        }
        let user_id = state
            .refresh_tokens
            .remove(refresh_token)
            .ok_or(RemoteError::Unauthorized)?;
        Ok(Self::issue(&mut state, &user_id, now))
    }

    fn sign_out(&self, access_token: &str) -> Result<(), RemoteError> {
        let mut state = self.state();
        state.calls.push(Call::SignOut {
            access_token: access_token.into(),
        });
        if let Some((user, _)) = state.access_tokens.remove(access_token) {
            // scope=local: this session's refresh tokens die with it (all of them, here).
            state.refresh_tokens.retain(|_, owner| *owner != user);
        }
        Ok(())
    }

    fn my_workspaces(&self, access_token: &str) -> Result<Vec<WorkspaceSummary>, RemoteError> {
        let now = self.clock.now();
        let mut state = self.state();
        state.calls.push(Call::MyWorkspaces);
        if let Some(err) = state.workspaces_failures.pop_front() {
            return Err(err);
        }
        let user = Self::user_for_access(&state, access_token, now)?;
        Ok(state.memberships.get(&user).cloned().unwrap_or_default())
    }

    fn create_workspace(&self, access_token: &str, name: &str) -> Result<String, RemoteError> {
        let now = self.clock.now();
        let mut state = self.state();
        state
            .calls
            .push(Call::CreateWorkspace { name: name.into() });
        let user = Self::user_for_access(&state, access_token, now)?;
        let id = uuid::Uuid::new_v4().to_string();
        state
            .memberships
            .entry(user)
            .or_default()
            .push(WorkspaceSummary {
                id: id.clone(),
                name: name.into(),
                role: WorkspaceRole::Owner,
                time_entry_visibility: TimeEntryVisibility::Private,
            });
        Ok(id)
    }

    fn accept_invitation(&self, access_token: &str, token: &str) -> Result<String, RemoteError> {
        let now = self.clock.now();
        let mut state = self.state();
        state.calls.push(Call::AcceptInvitation {
            token: token.into(),
        });
        let user = Self::user_for_access(&state, access_token, now)?;
        let (workspace_id, name, role) = state.invitations.remove(token).ok_or_else(|| {
            RemoteError::NotFound("this invitation is invalid or has expired".into())
        })?;
        state
            .memberships
            .entry(user)
            .or_default()
            .push(WorkspaceSummary {
                id: workspace_id.clone(),
                name,
                role,
                time_entry_visibility: TimeEntryVisibility::Private,
            });
        Ok(workspace_id)
    }

    fn create_invitation(
        &self,
        access_token: &str,
        workspace_id: &str,
        email: &str,
        role: WorkspaceRole,
    ) -> Result<InvitationCreated, RemoteError> {
        let now = self.clock.now();
        let mut state = self.state();
        state.calls.push(Call::CreateInvitation {
            workspace_id: workspace_id.into(),
            email: email.into(),
            role,
        });
        let user = Self::user_for_access(&state, access_token, now)?;
        let membership = state
            .memberships
            .get(&user)
            .and_then(|l| l.iter().find(|w| w.id == workspace_id))
            .cloned();
        match membership {
            Some(w) if w.role != WorkspaceRole::Member => {
                let token = format!("{:064x}", state.token_counter + 0xabc);
                state
                    .invitations
                    .insert(token.clone(), (w.id.clone(), w.name.clone(), role));
                Ok(InvitationCreated {
                    invitation_id: uuid::Uuid::new_v4().to_string(),
                    token,
                    expires_at: "2026-10-20T09:15:00.000Z".into(),
                })
            }
            _ => Err(RemoteError::Forbidden(
                "only owners and admins can invite".into(),
            )),
        }
    }

    fn sync_time_entries(
        &self,
        access_token: &str,
        workspace_id: &str,
        entries: &[RemoteTimeEntry],
    ) -> Result<Vec<EntryResult>, RemoteError> {
        let now = self.clock.now();
        let mut state = self.state();
        state.calls.push(Call::Sync {
            access_token: access_token.into(),
            workspace_id: workspace_id.into(),
            ids: entries.iter().map(|e| e.id.clone()).collect(),
            thread: std::thread::current().name().map(str::to_owned),
        });
        if let Some(err) = state.sync_failures.pop_front() {
            return Err(err);
        }
        // sync_time_entries: auth, membership, size — whole-call failures.
        let user = Self::user_for_access(&state, access_token, now)?;
        let member = state
            .memberships
            .get(&user)
            .is_some_and(|l| l.iter().any(|w| w.id == workspace_id));
        if !member {
            return Err(RemoteError::Forbidden(
                "not a member of this workspace".into(),
            ));
        }
        assert!(
            entries.len() <= 500,
            "the server refuses more than 500 entries"
        );
        let mut results = Vec::new();
        for entry in entries {
            // Postgres renders a uuid in lower case, whatever case the client sent.
            let id = entry.id.to_ascii_lowercase();
            if state.omit_ids.contains(&id) {
                continue;
            }
            if let Some(existing) = state.entries.get(&id) {
                let outcome = if existing.user_id == user {
                    EntryOutcome::Synced // "already present"
                } else {
                    EntryOutcome::Rejected("23505: duplicate key value".into())
                };
                results.push(EntryResult { id, outcome });
                continue;
            }
            if let Some(detail) = state.reject_ids.get(&id).cloned() {
                results.push(EntryResult {
                    id,
                    outcome: EntryOutcome::Rejected(detail),
                });
                continue;
            }
            state.inserts.push(id.clone());
            state.entries.insert(
                id.clone(),
                ServerEntry {
                    user_id: user.clone(),
                    workspace_id: workspace_id.into(),
                    entry: entry.clone(),
                },
            );
            results.push(EntryResult {
                id,
                outcome: EntryOutcome::Synced,
            });
        }
        if state.lost_responses > 0 {
            // Committed, but the answer never arrives.
            state.lost_responses -= 1;
            return Err(RemoteError::Network(
                "the connection was interrupted".into(),
            ));
        }
        Ok(results)
    }

    fn delete_time_entries(&self, access_token: &str, ids: &[String]) -> Result<(), RemoteError> {
        let now = self.clock.now();
        let mut state = self.state();
        state.calls.push(Call::DeleteEntries { ids: ids.to_vec() });
        if let Some(err) = state.delete_failures.pop_front() {
            return Err(err);
        }
        let user = Self::user_for_access(&state, access_token, now)?;
        for id in ids {
            let id = id.to_ascii_lowercase();
            // RLS: only the caller's own rows; others are silently not matched.
            if state.entries.get(&id).is_some_and(|e| e.user_id == user) {
                state.entries.remove(&id);
            }
        }
        Ok(())
    }
}

// ---- wiring ---------------------------------------------------------------------------------

pub fn test_config() -> SupabaseConfig {
    SupabaseConfig::validate(
        "https://abcd1234.supabase.co",
        "sb_publishable_test_key_123",
    )
    .expect("valid test config")
}

/// Everything a test needs, wired the way `lib.rs` wires the real thing.
pub struct World {
    pub clock: TestClock,
    pub remote: Arc<FakeRemote>,
    pub ledger: Arc<FakeLedger>,
    pub credentials: Arc<MemoryCredentialStore>,
    pub account: Arc<AccountManager>,
    /// The default user ([`EMAIL`] / [`PASSWORD`]).
    pub user_id: String,
}

impl World {
    /// A configured app, signed out, with one registered user and no memberships.
    pub fn new() -> Self {
        let clock = TestClock::new(T0);
        let remote = Arc::new(FakeRemote::new(clock.clone()));
        let user_id = remote.add_user(EMAIL, PASSWORD, Some("Ada"));
        let ledger = Arc::new(FakeLedger::default());
        let credentials = Arc::new(MemoryCredentialStore::default());
        let account = Arc::new(Self::manager(&clock, &remote, &ledger, &credentials));
        Self {
            clock,
            remote,
            ledger,
            credentials,
            account,
            user_id,
        }
    }

    /// A second manager over the same credential store and ledger (an app restart).
    pub fn restart(&self) -> Arc<AccountManager> {
        Arc::new(Self::manager(
            &self.clock,
            &self.remote,
            &self.ledger,
            &self.credentials,
        ))
    }

    fn manager(
        clock: &TestClock,
        remote: &Arc<FakeRemote>,
        ledger: &Arc<FakeLedger>,
        credentials: &Arc<MemoryCredentialStore>,
    ) -> AccountManager {
        let api: Arc<dyn RemoteApi> = remote.clone();
        let creds: Arc<dyn CredentialStore> = credentials.clone();
        let ledger: Arc<dyn SyncLedger> = ledger.clone();
        AccountManager::new(
            Ok(test_config()),
            Some(api),
            creds,
            ledger,
            clock.boxed_sync(),
        )
    }

    /// Sign the default user in with one membership (selected automatically).
    pub fn signed_in_with_workspace() -> Self {
        let world = Self::new();
        world
            .remote
            .add_membership(&world.user_id, WS_A, "Studio A", WorkspaceRole::Owner);
        world.account.sign_in(EMAIL, PASSWORD).expect("sign in");
        assert_eq!(world.ledger.state().sync_workspace.as_deref(), Some(WS_A));
        world
    }

    pub fn stored(&self) -> Option<StoredSession> {
        self.credentials.load().unwrap()
    }

    pub fn core(&self, settings: SyncSettings) -> SyncCore {
        let api: Arc<dyn RemoteApi> = self.remote.clone();
        let ledger: Arc<dyn SyncLedger> = self.ledger.clone();
        SyncCore::new(
            ledger,
            Arc::clone(&self.account),
            Some(api),
            settings,
            self.clock.boxed(),
            Box::new(|| 0.5),
        )
    }
}

/// Settings with small numbers that are easy to reason about (jitter 0.5 = no jitter).
pub fn settings(batch_size: usize) -> SyncSettings {
    SyncSettings {
        batch_size,
        base_delay_ms: 1_000,
        max_delay_ms: 8_000,
        idle_interval_ms: 60_000,
    }
}
