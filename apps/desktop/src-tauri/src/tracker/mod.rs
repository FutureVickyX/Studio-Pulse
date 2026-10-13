//! Automatic application tracking: the pure accounting [`engine`] and the background
//! [`service`] that feeds it samples from the platform layer and persists its output.

pub mod engine;
pub mod service;
pub mod types;

pub use engine::Engine;
pub use types::*;
