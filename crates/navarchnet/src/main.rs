use navarchnet::{api, auth::Auth, executor, store::Store};
use std::{net::SocketAddr, sync::Arc};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    if std::env::args().nth(1).as_deref() == Some("--healthcheck") {
        use std::io::{Read, Write};
        let configured: SocketAddr = std::env::var("NAVARCHNET_BIND")
            .unwrap_or_else(|_| "127.0.0.1:8080".into())
            .parse()?;
        let address = if configured.ip().is_unspecified() {
            SocketAddr::new(
                if configured.is_ipv4() {
                    std::net::Ipv4Addr::LOCALHOST.into()
                } else {
                    std::net::Ipv6Addr::LOCALHOST.into()
                },
                configured.port(),
            )
        } else {
            configured
        };
        let mut stream =
            std::net::TcpStream::connect_timeout(&address, std::time::Duration::from_secs(2))?;
        stream.set_read_timeout(Some(std::time::Duration::from_secs(2)))?;
        stream.set_write_timeout(Some(std::time::Duration::from_secs(2)))?;
        stream
            .write_all(b"GET /readyz HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")?;
        let expected = b"HTTP/1.1 200 ";
        let mut response = vec![0; expected.len()];
        stream.read_exact(&mut response)?;
        anyhow::ensure!(response == expected, "Readiness check failed");
        return Ok(());
    }
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    let mode = std::env::var("NAVARCHNET_AUTH_MODE").unwrap_or_default();
    let auth = match mode.as_str() {
        "demo" => Auth::demo(
            std::env::var("NAVARCHNET_ADMIN_TOKEN")?,
            std::env::var("NAVARCHNET_READER_TOKEN")?,
        )?,
        "oidc" => Auth::oidc(
            &std::fs::read(std::env::var("NAVARCHNET_OIDC_KEY_FILE")?)?,
            std::env::var("NAVARCHNET_OIDC_ISSUER")?,
            std::env::var("NAVARCHNET_OIDC_AUDIENCE")?,
        )?,
        _ => anyhow::bail!("Set NAVARCHNET_AUTH_MODE explicitly to demo or oidc"),
    };
    let bind: SocketAddr = std::env::var("NAVARCHNET_BIND")
        .unwrap_or_else(|_| "127.0.0.1:8080".into())
        .parse()?;
    anyhow::ensure!(
        !auth.is_demo()
            || bind.ip().is_loopback()
            || std::env::var("NAVARCHNET_ALLOW_DEMO_NETWORK").as_deref() == Ok("true"),
        "Demo authentication must bind loopback unless explicitly opted into isolated container networking"
    );
    let store = Store::connect(&std::env::var("DATABASE_URL")?).await?;
    let aws = navarchnet::aws::service::configure(
        std::env::var("NAVARCHNET_AWS_READ_ONLY").ok().as_deref(),
        std::env::var("NAVARCHNET_AWS_REGIONS").ok().as_deref(),
        auth.is_demo(),
    )?
    .map(|provider| Arc::new(provider) as Arc<dyn navarchnet::aws::service::ReadOnlyAws>);
    store.migrate().await?;
    let state = api::AppState {
        store: store.clone(),
        auth: Arc::new(auth),
        aws,
    };
    let (stop, mut stopped) = tokio::sync::watch::channel(false);
    let worker_store = store.clone();
    let worker = tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = stopped.changed() => break,
                _ = tokio::time::sleep(std::time::Duration::from_millis(100)) => {
                    if let Err(error) = executor::tick(&worker_store).await { tracing::warn!(error=%error,"Executor iteration failed; operation remains durable"); }
                }
            }
        }
    });
    let listener = tokio::net::TcpListener::bind(bind).await?;
    tracing::info!(address=%bind,aws_read_only=state.aws.is_some(),"NavarchNet started; AWS execution disabled; active connectivity untested");
    let result = axum::serve(listener, api::router(state))
        .with_graceful_shutdown(async move {
            #[cfg(unix)]
            {
                let mut term =
                    tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                        .expect("SIGTERM registration");
                tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = term.recv() => {} }
            }
            #[cfg(not(unix))]
            {
                let _ = tokio::signal::ctrl_c().await;
            }
            let _ = stop.send(true);
        })
        .await;
    worker.await?;
    store.pool.close().await;
    result?;
    Ok(())
}
