//! A tiny example emitter for the tracer stack.
//!
//! Each process plays one "node" of a toy consensus protocol: once per
//! interval it runs a round (prepare → exchange → commit) instrumented with
//! the `tracing` crate and ships the spans/events to Tempo over OTLP via
//! `tracing-opentelemetry`.
//!
//! The one deliberate trick: every node derives the same trace id for a
//! given height, so the spans of all nodes land in a single trace and the
//! viewer can overlay them per instance.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use opentelemetry::trace::{
    SpanContext, SpanId, TraceContextExt, TraceFlags, TraceId, TraceState, TracerProvider as _,
};
use opentelemetry::{Context, KeyValue};
use opentelemetry_otlp::WithExportConfig;
use opentelemetry_sdk::{trace::SdkTracerProvider, Resource};
use rand::{rngs::StdRng, Rng, SeedableRng};
use sha2::{Digest, Sha256};
use tracing::{debug_span, info_span, trace_span, warn_span, Instrument};
use tracing_opentelemetry::OpenTelemetrySpanExt;
use tracing_subscriber::filter::Targets;
use tracing_subscriber::layer::{Layer as _, SubscriberExt};
use tracing_subscriber::util::SubscriberInitExt;

struct Config {
    node_id: u64,
    num_nodes: u64,
    otlp_endpoint: String,
    round_interval_ms: u64,
    run_id: String,
    fail_rate: f64,
}

impl Config {
    fn from_env() -> Self {
        Self {
            node_id: env_or("NODE_ID", 0),
            num_nodes: env_or("NUM_NODES", 4).max(1),
            otlp_endpoint: env_or("OTLP_ENDPOINT", "http://localhost:4317".to_string()),
            round_interval_ms: env_or("ROUND_INTERVAL_MS", 1000).max(100),
            run_id: env_or("RUN_ID", "local".to_string()),
            fail_rate: env_or("FAIL_RATE", 0.02_f64).clamp(0.0, 1.0),
        }
    }
}

fn env_or<T: std::str::FromStr>(key: &str, default: T) -> T {
    std::env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

/// Every node derives the same trace id for a height, so all nodes' spans
/// join one trace. The parent span id is left invalid: each node's `round`
/// span is exported as a root of that shared trace.
fn shared_trace_parent(run_id: &str, height: u64) -> Context {
    let digest = Sha256::digest(format!("{run_id}:{height}"));
    let trace_id = TraceId::from_bytes(digest[..16].try_into().expect("digest >= 16 bytes"));
    Context::new().with_remote_span_context(SpanContext::new(
        trace_id,
        SpanId::INVALID,
        TraceFlags::SAMPLED,
        true,
        TraceState::default(),
    ))
}

async fn jitter(rng: &mut StdRng, lo_ms: u64, hi_ms: u64) {
    tokio::time::sleep(Duration::from_millis(rng.random_range(lo_ms..hi_ms))).await;
}

/// Deterministic child RNG for a concurrent sub-task. Parallel branches can't
/// share one `&mut rng`, so each gets its own stream seeded from (height, node,
/// salt) — keeping a given height's trace reproducible across runs.
fn subseed(cfg: &Config, height: u64, salt: u64) -> StdRng {
    StdRng::seed_from_u64(
        height
            .wrapping_mul(31)
            .wrapping_add(cfg.node_id)
            .wrapping_mul(1009)
            .wrapping_add(salt),
    )
}

async fn round(cfg: &Config, height: u64) {
    // Deterministic per (node, height) so reruns of a height are comparable.
    let mut rng = StdRng::seed_from_u64(height.wrapping_mul(31).wrapping_add(cfg.node_id));
    let leader = height % cfg.num_nodes == cfg.node_id;
    let role = if leader { "leader" } else { "follower" };

    // Decide the outcome up front so commit/apply agree.
    let failed = rng.random_bool(cfg.fail_rate);
    let bytes = rng.random_range(1_000..200_000_u64) as i64;

    let span = info_span!(
        "round",
        height = height as i64,
        role,
        node.id = cfg.node_id as i64,
        level = "info"
    );
    span.set_parent(shared_trace_parent(&cfg.run_id, height))
        .expect("otel layer is installed on the subscriber");

    async {
        // prepare: load local state and validate the mempool concurrently;
        // mempool validation itself fans into fetch + verify sub-spans.
        async {
            let mut r_state = subseed(cfg, height, 1);
            let mut r_mem = subseed(cfg, height, 2);
            tokio::join!(
                async {
                    jitter(&mut r_state, 1, 8).await;
                    tracing::debug!("state.loaded");
                }
                .instrument(debug_span!("load_state", level = "debug")),
                async {
                    async { jitter(&mut r_mem, 1, 6).await }
                        .instrument(trace_span!("fetch_txs", level = "trace"))
                        .await;
                    async {
                        jitter(&mut r_mem, 1, 6).await;
                        tracing::trace!("signatures.verified");
                    }
                    .instrument(trace_span!("verify_sigs", level = "trace"))
                    .await;
                }
                .instrument(debug_span!("validate_mempool", level = "debug")),
            );
        }
        .instrument(debug_span!("prepare", level = "debug"))
        .await;

        // propose (leader only): build the block (collect txs ∥ compute root),
        // then sign it.
        if leader {
            async {
                tracing::info!(height = height as i64, "proposal.broadcast");
                async {
                    let mut r_tx = subseed(cfg, height, 3);
                    let mut r_root = subseed(cfg, height, 4);
                    tokio::join!(
                        async {
                            jitter(&mut r_tx, 3, 14).await;
                            let txs = r_tx.random_range(10..500) as i64;
                            tracing::debug!(txs, "txs.collected");
                        }
                        .instrument(debug_span!("collect_txs", level = "debug")),
                        async {
                            jitter(&mut r_root, 2, 10).await;
                            tracing::trace!("merkle.root.computed");
                        }
                        .instrument(debug_span!("compute_root", level = "debug")),
                    );
                }
                .instrument(info_span!("build_block", level = "info"))
                .await;
                async {
                    let mut r_sign = subseed(cfg, height, 5);
                    jitter(&mut r_sign, 2, 8).await;
                    tracing::debug!("block.signed");
                }
                .instrument(debug_span!("sign", level = "debug"))
                .await;
            }
            .instrument(info_span!("propose", level = "info"))
            .await;
        }

        // exchange: message every peer concurrently. Each peer is its own
        // sub-tree (serialize → await_ack), so the spans overlap in time.
        async {
            tracing::info!("msg.sent");
            let sends = (0..cfg.num_nodes)
                .filter(|p| *p != cfg.node_id)
                .map(|peer| {
                    let mut pr = subseed(cfg, height, 100 + peer);
                    async move {
                        async { jitter(&mut pr, 1, 4).await }
                            .instrument(trace_span!("serialize", level = "trace"))
                            .await;
                        async {
                            jitter(&mut pr, 2, 15).await;
                            tracing::info!(from.node = peer as i64, "ack.received");
                        }
                        .instrument(trace_span!("await_ack", level = "trace"))
                        .await;
                    }
                    .instrument(debug_span!("peer", peer = peer as i64, level = "debug"))
                })
                .collect::<Vec<_>>();
            futures::future::join_all(sends).await;
        }
        .instrument(info_span!(
            "exchange",
            level = "info",
            peers = (cfg.num_nodes - 1) as i64
        ))
        .await;

        // Occasional long stall before commit, as its own warn span.
        if !failed && rng.random_bool(0.05) {
            async { jitter(&mut rng, 80, 250).await }
                .instrument(warn_span!("timeout", level = "warn"))
                .await;
        }

        let commit_span = if failed {
            info_span!(
                "commit",
                level = "error",
                otel.status_code = "ERROR",
                otel.status_description = "quorum not reached"
            )
        } else {
            info_span!("commit", level = "info")
        };
        async {
            jitter(&mut rng, 5, 40).await;
            if failed {
                tracing::error!(level = "error", "commit failed: quorum not reached");
            } else {
                tracing::info!(level = "info", bytes, "commit.done");
            }
        }
        .instrument(commit_span)
        .await;

        // apply (on success): update in-memory state ∥ persist the block.
        if !failed {
            async {
                let mut r_upd = subseed(cfg, height, 6);
                let mut r_per = subseed(cfg, height, 7);
                tokio::join!(
                    async {
                        jitter(&mut r_upd, 2, 12).await;
                        tracing::debug!("state.updated");
                    }
                    .instrument(debug_span!("update_state", level = "debug")),
                    async {
                        jitter(&mut r_per, 5, 25).await;
                        tracing::info!(bytes, "block.persisted");
                    }
                    .instrument(debug_span!("persist", level = "debug")),
                );
            }
            .instrument(info_span!("apply", level = "info"))
            .await;
        }
    }
    .instrument(span)
    .await;
}

/// Background chatter in its own (random) trace — search-result variety.
async fn gossip(cfg: &Config, rng: &mut StdRng) {
    let level = match rng.random_range(0..10) {
        0 => "warn",
        1..=4 => "debug",
        _ => "info",
    };
    let span = info_span!("gossip", level, node.id = cfg.node_id as i64);
    // Pre-draw seeds so the concurrent pings each own an RNG (no shared &mut).
    let seeds = [rng.random::<u64>(), rng.random::<u64>()];
    async {
        tracing::info!(peers = (cfg.num_nodes - 1) as i64, "gossip.exchange");
        let pings = seeds
            .into_iter()
            .enumerate()
            .map(|(k, seed)| {
                let mut pr = StdRng::seed_from_u64(seed);
                async move {
                    jitter(&mut pr, 1, 40).await;
                    tracing::debug!(target_peer = k as i64, "ping.ack");
                }
                .instrument(debug_span!("ping", level = "debug", k = k as i64))
            })
            .collect::<Vec<_>>();
        futures::future::join_all(pings).await;
    }
    .instrument(span)
    .await;
}

async fn shutdown_signal() {
    let ctrl_c = tokio::signal::ctrl_c();
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("install SIGTERM handler");
        tokio::select! {
            _ = ctrl_c => {}
            _ = term.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        ctrl_c.await.ok();
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cfg = Config::from_env();

    let exporter = opentelemetry_otlp::SpanExporter::builder()
        .with_tonic()
        .with_endpoint(&cfg.otlp_endpoint)
        .build()?;
    let provider = SdkTracerProvider::builder()
        .with_batch_exporter(exporter)
        .with_resource(
            Resource::builder()
                .with_service_name(format!("node-{}", cfg.node_id))
                .with_attribute(KeyValue::new("node.id", cfg.node_id as i64))
                .build(),
        )
        .build();
    // Only export this crate's spans: the OTLP exporter's own gRPC stack
    // (tonic/h2) is instrumented with `tracing` too, and without the filter
    // its internal spans would feed back into the exporter.
    tracing_subscriber::registry()
        .with(
            tracing_opentelemetry::layer()
                .with_tracer(provider.tracer("consensus-sim"))
                .with_filter(Targets::new().with_target("consensus_sim", tracing::Level::TRACE)),
        )
        .init();

    println!(
        "consensus-sim node={}/{} endpoint={} interval={}ms run={} fail_rate={}",
        cfg.node_id,
        cfg.num_nodes,
        cfg.otlp_endpoint,
        cfg.round_interval_ms,
        cfg.run_id,
        cfg.fail_rate
    );

    let mut rng = StdRng::seed_from_u64(cfg.node_id);
    // One signal listener for the whole run: a fresh listener per iteration
    // would miss signals delivered while a round is executing.
    let mut shutdown = std::pin::pin!(shutdown_signal());
    loop {
        // Wall-clock-aligned heights: independently started nodes agree on
        // the current height without any coordination.
        let now_ms = SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis() as u64;
        let height = now_ms / cfg.round_interval_ms + 1;
        let wait = Duration::from_millis(height * cfg.round_interval_ms - now_ms);
        tokio::select! {
            _ = tokio::time::sleep(wait) => {}
            _ = &mut shutdown => break,
        }

        round(&cfg, height).await;
        gossip(&cfg, &mut rng).await;
        let role = if height % cfg.num_nodes == cfg.node_id {
            "leader"
        } else {
            "follower"
        };
        println!("round height={height} role={role}");
    }

    println!("shutting down, flushing spans...");
    provider.shutdown()?;
    Ok(())
}
