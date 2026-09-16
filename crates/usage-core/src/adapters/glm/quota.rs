//! GLM Coding Plan quota collection (task 3.4).
//!
//! Three read-only GETs against the region's provider-owned domain:
//!
//! | path | purpose |
//! | --- | --- |
//! | `/api/monitor/usage/model-usage` | per-model token activity for the range |
//! | `/api/monitor/usage/tool-usage` | per-tool call activity for the range |
//! | `/api/monitor/usage/quota/limit` | the Coding Plan windows |
//!
//! The region is resolved at refresh time, so changing it in the settings applies
//! to the next refresh. The credential is sent as the `Authorization` header
//! verbatim, exactly like the legacy implementation.
//!
//! # What the metrics mean
//!
//! `quota.5h.*`, `quota.weekly.*` and `quota.tools.monthly.*` keep the legacy key
//! convention. The model windows are identified by `unit` + `number` (both can
//! have the same `TOKENS_LIMIT` or `CREDIT_LIMIT` type), with `resetAt` from
//! `nextResetTime` (unix **milliseconds**) and
//! `windowSeconds` from `windowDuration`; the 18000/604800 fallbacks are only used
//! for the 5h and weekly windows. A limit entry the collector does not recognize
//! produces **no** metric: it goes to a redacted `diagnostic.unknownLimits` entry,
//! and if nothing at all is recognized the refresh fails as `compatibility` rather
//! than reporting a healthy empty card.
//!
//! Model/tool activity becomes `model.<name>.tokens` / `tool.<name>.count`, each
//! carrying a [`StatisticScope`]. An empty activity response produces no metric —
//! not a zero-length metric, not a zero.

use std::sync::Arc;

use serde_json::{Map, Value};

use super::{
    duration_seconds, ensure_same_origin, quota_connection, quota_get,
    range_confirmed_from_envelope, read_json, redacted_entry, reset_at_from_millis, short,
    unknown_limits_diagnostic, unwrap_data, CredentialResolver, GlmRefreshContext, RegionResolver,
    StatisticsRange, QUOTA_SOURCE,
};
use crate::contracts::{
    ConnectionStatus, GlmRegion, IsoTimestamp, MetricCapability, MetricDirection, MetricInput,
    MetricValue, ProviderId, ProviderSnapshot, StatisticScope, UsageMetric,
};
use crate::transport::{CollectorError as CollectorFailure, SharedHttpTransport};

/// Path of the per-model activity endpoint.
pub const MODEL_USAGE_PATH: &str = "/api/monitor/usage/model-usage";
/// Path of the per-tool activity endpoint.
pub const TOOL_USAGE_PATH: &str = "/api/monitor/usage/tool-usage";
/// Path of the Coding Plan quota endpoint.
pub const QUOTA_LIMIT_PATH: &str = "/api/monitor/usage/quota/limit";

/// Reads the GLM Coding Plan quota for one region.
pub struct GlmQuotaCollector {
    transport: SharedHttpTransport,
    region: RegionResolver,
    credential: CredentialResolver,
}

impl std::fmt::Debug for GlmQuotaCollector {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // The credential resolver is deliberately not rendered.
        formatter
            .debug_struct("GlmQuotaCollector")
            .field("base_domain", &self.base_domain())
            .finish_non_exhaustive()
    }
}

impl GlmQuotaCollector {
    /// Build a collector with the China region and no credential configured.
    pub fn new(transport: SharedHttpTransport) -> Self {
        Self {
            transport,
            region: Arc::new(|| GlmRegion::China),
            credential: Arc::new(|| None),
        }
    }

    /// Use a fixed region.
    pub fn with_region(mut self, region: GlmRegion) -> Self {
        self.region = Arc::new(move || region);
        self
    }

    /// Resolve the region on every refresh (a settings change must apply to the
    /// next refresh, not the next restart).
    pub fn with_region_resolver(mut self, resolver: RegionResolver) -> Self {
        self.region = resolver;
        self
    }

    /// Read the credential on every refresh.
    pub fn with_credential(mut self, credential: CredentialResolver) -> Self {
        self.credential = credential;
        self
    }

    /// Convenience for a credential that is already available.
    pub fn with_credential_value(mut self, credential: impl Into<String>) -> Self {
        let credential = credential.into();
        self.credential = Arc::new(move || Some(credential.clone()));
        self
    }

    /// The region selected for the next refresh.
    pub fn region(&self) -> GlmRegion {
        (self.region)()
    }

    /// The provider-owned domain of the selected region.
    pub fn base_domain(&self) -> &'static str {
        self.region().base_domain()
    }

    /// Collect one Coding Plan snapshot for `context`.
    pub async fn refresh(
        &self,
        context: &GlmRefreshContext,
    ) -> Result<ProviderSnapshot, CollectorFailure> {
        let credential = (self.credential)();
        let credential = credential
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                CollectorFailure::missing_config("GLM Coding Plan API key is not configured")
            })?;

        let base = self.base_domain();
        let base_url = url::Url::parse(base).map_err(|_| {
            CollectorFailure::compatibility("the GLM region domain is not a valid absolute URL")
        })?;
        let range = context.range()?;
        let query = range.query_string();

        let (model_response, tool_response, quota_response) = tokio::join!(
            self.transport.get(quota_get(
                format!("{base}{MODEL_USAGE_PATH}?{query}"),
                credential
            )),
            self.transport.get(quota_get(
                format!("{base}{TOOL_USAGE_PATH}?{query}"),
                credential
            )),
            self.transport
                .get(quota_get(format!("{base}{QUOTA_LIMIT_PATH}"), credential)),
        );

        let model_response = model_response?;
        ensure_same_origin(&model_response, &base_url)?;
        let tool_response = tool_response?;
        ensure_same_origin(&tool_response, &base_url)?;
        let quota_response = quota_response?;
        ensure_same_origin(&quota_response, &base_url)?;

        let models = read_json(model_response, "GLM model usage")?;
        let tools = read_json(tool_response, "GLM tool usage")?;
        let quota = read_json(quota_response, "GLM quota")?;

        normalize_glm_payloads(&quota, &models, &tools, context)
    }

    /// The statistics range the next refresh of this collector would query.
    pub fn range(&self, context: &GlmRefreshContext) -> Result<StatisticsRange, CollectorFailure> {
        context.range()
    }
}

/// The three quota windows the panel knows about.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum QuotaWindow {
    FiveHour,
    Weekly,
    ToolsMonthly,
}

impl QuotaWindow {
    fn suffix(self) -> &'static str {
        match self {
            QuotaWindow::FiveHour => "5h",
            QuotaWindow::Weekly => "weekly",
            QuotaWindow::ToolsMonthly => "tools.monthly",
        }
    }

    /// The legacy fallback, only defined for the two provider windows.
    fn fallback_window_seconds(self) -> Option<u64> {
        match self {
            QuotaWindow::FiveHour => Some(18_000),
            QuotaWindow::Weekly => Some(604_800),
            QuotaWindow::ToolsMonthly => None,
        }
    }
}

/// Which window a limit entry describes. GLM uses the same token/credit `type`
/// for both model windows; `unit` + `number` must win over that legacy label.
fn quota_window(entry: &Value) -> Option<QuotaWindow> {
    let entry_type = entry.get("type").and_then(Value::as_str)?;
    let upper = entry_type.to_ascii_uppercase();
    if upper == "TIME_LIMIT" {
        return Some(QuotaWindow::ToolsMonthly);
    }
    if upper != "TOKENS_LIMIT" && upper != "CREDIT_LIMIT" && !upper.contains("WEEK") {
        return None;
    }
    let unit = entry.get("unit").and_then(Value::as_u64);
    let number = entry.get("number").and_then(Value::as_u64);
    match (unit, number) {
        (Some(3), Some(5)) => return Some(QuotaWindow::FiveHour),
        (Some(6), Some(1)) => return Some(QuotaWindow::Weekly),
        _ => {}
    }
    let window = entry
        .get("windowDuration")
        .and_then(Value::as_str)
        .map(|value| value.trim().to_ascii_lowercase());

    if upper.contains("WEEK")
        || window.as_deref() == Some("7d")
        || window.as_deref() == Some("168h")
        || window.as_deref() == Some("1w")
    {
        return Some(QuotaWindow::Weekly);
    }
    if window.as_deref() == Some("5h") {
        return Some(QuotaWindow::FiveHour);
    }
    None
}

/// A finite, non-negative platform count.
fn non_negative(raw: Option<&Value>) -> Option<f64> {
    raw.and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value >= 0.0)
}

/// Normalize the three GLM monitor payloads into one quota snapshot.
///
/// Kept separate from the HTTP refresh so the parsing rules can be tested with
/// payloads alone, exactly like the legacy `normalizeGlmPayloads`.
pub fn normalize_glm_payloads(
    quota_response: &Value,
    model_response: &Value,
    tool_response: &Value,
    context: &GlmRefreshContext,
) -> Result<ProviderSnapshot, CollectorFailure> {
    let range = context.range()?;

    let quota = unwrap_data(quota_response);
    let limits = quota
        .get("limits")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            CollectorFailure::compatibility("GLM quota response omitted the limits array")
        })?;

    let mut metrics: Vec<UsageMetric> = Vec::new();
    let mut unknown_limits: Vec<Value> = Vec::new();

    for entry in limits {
        let Some(window) = quota_window(entry) else {
            // Unrecognized entries are kept as a redacted diagnostic only: no
            // metric, and never a raw credential in the stored snapshot.
            unknown_limits.push(redacted_entry(entry));
            continue;
        };

        let entry_type = entry
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let displayed_type = short(entry_type, 60);
        let percentage = entry
            .get("percentage")
            .and_then(Value::as_f64)
            .ok_or_else(|| {
                CollectorFailure::compatibility(format!(
                    "GLM quota {displayed_type} omitted percentage"
                ))
            })?;
        if !percentage.is_finite() || !(0.0..=100.0).contains(&percentage) {
            return Err(CollectorFailure::compatibility(format!(
                "GLM quota {displayed_type} reported an out-of-range percentage"
            )));
        }

        let reset_at = reset_at_from_millis(entry.get("nextResetTime"));
        let window_seconds = entry
            .get("windowDuration")
            .and_then(Value::as_str)
            .and_then(duration_seconds)
            .or_else(|| window.fallback_window_seconds());

        let mut details = Map::new();
        details.insert("type".to_string(), Value::String(short(entry_type, 120)));
        if let Some(current_value) = entry.get("currentValue").and_then(Value::as_f64) {
            if current_value.is_finite() {
                details.insert("currentValue".to_string(), Value::from(current_value));
            }
        }
        if let Some(limit) = entry.get("usage").and_then(Value::as_f64) {
            if limit.is_finite() {
                details.insert("limit".to_string(), Value::from(limit));
            }
        }

        let suffix = window.suffix();
        metrics.push(quota_metric(
            format!("quota.{suffix}.used"),
            format!("{suffix} used"),
            percentage,
            MetricDirection::Used,
            reset_at.clone(),
            window_seconds,
            details.clone(),
        )?);
        metrics.push(quota_metric(
            format!("quota.{suffix}.remaining"),
            format!("{suffix} remaining"),
            100.0 - percentage,
            MetricDirection::Remaining,
            reset_at,
            window_seconds,
            details,
        )?);
    }

    if metrics.is_empty() {
        let encoded = serde_json::to_string(&Value::Array(unknown_limits.clone()))
            .unwrap_or_else(|_| "[]".to_string());
        return Err(CollectorFailure::compatibility(
            "GLM quota response contains no recognized quota entries",
        )
        .with_diagnostic("unknownLimits", encoded));
    }

    let model_scope = range.scope(range_confirmed_from_envelope(model_response, &range));
    for entry in activity_entries(model_response) {
        let Some(model) = usable_name(entry, "model") else {
            continue;
        };
        let Some(tokens) = non_negative(entry.get("tokens")) else {
            continue;
        };
        metrics.push(activity_metric(
            format!("model.{model}.tokens"),
            &model,
            tokens,
            "tokens",
            &model_scope,
        )?);
    }

    let tool_scope = range.scope(range_confirmed_from_envelope(tool_response, &range));
    for entry in activity_entries(tool_response) {
        let Some(tool) = usable_name(entry, "tool") else {
            continue;
        };
        let Some(count) =
            non_negative(entry.get("count")).or_else(|| non_negative(entry.get("usage")))
        else {
            continue;
        };
        metrics.push(activity_metric(
            format!("tool.{tool}.count"),
            &tool,
            count,
            "calls",
            &tool_scope,
        )?);
    }

    let captured_at = IsoTimestamp::from_datetime(context.now);
    Ok(ProviderSnapshot {
        provider: ProviderId::Glm,
        connection: Some(quota_connection()),
        status: ConnectionStatus::Connected,
        captured_at: captured_at.clone(),
        last_success_at: Some(captured_at),
        source: QUOTA_SOURCE.to_string(),
        metrics,
        error: None,
        diagnostic: Some(unknown_limits_diagnostic(unknown_limits)),
        extra: Map::new(),
    })
}

/// One `quota.<window>.<direction>` metric.
fn quota_metric(
    key: String,
    label: String,
    value: f64,
    direction: MetricDirection,
    reset_at: Option<IsoTimestamp>,
    window_seconds: Option<u64>,
    details: Map<String, Value>,
) -> Result<UsageMetric, CollectorFailure> {
    UsageMetric::normalize(MetricInput {
        key,
        label: Some(label),
        value: Some(MetricValue::Number(value)),
        unit: "percent".to_string(),
        direction,
        reset_at,
        window_seconds,
        confidence: None,
        source: QUOTA_SOURCE.to_string(),
        details: Some(details),
        connection: Some(quota_connection()),
        capability: Some(MetricCapability::Supported),
        scope: None,
        ..MetricInput::default()
    })
    .map_err(|error| {
        CollectorFailure::compatibility(format!("GLM quota metric was rejected: {error}"))
    })
}

/// One model/tool activity metric, scoped to the queried range.
fn activity_metric(
    key: String,
    label: &str,
    value: f64,
    unit: &str,
    scope: &StatisticScope,
) -> Result<UsageMetric, CollectorFailure> {
    UsageMetric::normalize(MetricInput {
        key,
        label: Some(label.to_string()),
        value: Some(MetricValue::Number(value)),
        unit: unit.to_string(),
        direction: MetricDirection::Activity,
        confidence: None,
        source: QUOTA_SOURCE.to_string(),
        details: None,
        connection: Some(quota_connection()),
        capability: Some(MetricCapability::Supported),
        scope: Some(scope.clone()),
        ..MetricInput::default()
    })
    .map_err(|error| {
        CollectorFailure::compatibility(format!("GLM activity metric was rejected: {error}"))
    })
}

/// The activity array of a response, or an empty slice when the provider sent
/// something else. An empty response produces no metrics instead of zeros.
fn activity_entries(response: &Value) -> &[Value] {
    match unwrap_data(response).as_array() {
        Some(entries) => entries.as_slice(),
        None => &[],
    }
}

/// The non-empty `model`/`tool` name of an activity entry.
fn usable_name(entry: &Value, field: &str) -> Option<String> {
    entry
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
}
