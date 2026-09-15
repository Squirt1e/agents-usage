//! Platform collectors.
//!
//! Every collector is a read-only adapter over the traits in [`crate::http`]:
//! it turns platform responses into the [`crate::contracts`] vocabulary and
//! never calls a model, buys credit or mutates a subscription.
//!
//! A provider may own more than one *connection*. GLM runs a Coding Plan quota
//! connection and a separate experimental wallet connection; they hold their own
//! credentials, health and cache, and [`glm::GlmView`] composes them so a failure
//! on one side never erases the other.
//!
//! Codex is a single connection (`codex:account`) reached through the local
//! `codex app-server` process; see [`codex`] for the JSON-RPC session, the quota
//! normalization and the CLI discovery used when no shell PATH is inherited.

pub mod codex;
pub mod deepseek;
pub mod deepseek_web;
pub mod glm;
