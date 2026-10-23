use navarchnet::store::Store;

pub async fn isolated() -> anyhow::Result<(Store, String)> {
    let base = std::env::var("DATABASE_URL")
        .expect("DATABASE_URL is mandatory; real PostgreSQL tests never skip");
    let admin = Store::connect(&base).await?;
    let schema = format!("test_{}", uuid::Uuid::new_v4().simple());
    // Identifier contains only a fixed prefix and generated UUID hexadecimal digits.
    sqlx::query(sqlx::AssertSqlSafe(format!("CREATE SCHEMA {schema}")))
        .execute(&admin.pool)
        .await?;
    admin.pool.close().await;
    let separator = if base.contains('?') { '&' } else { '?' };
    let url = format!("{base}{separator}options=-csearch_path%3D{schema}");
    let store = Store::connect(&url).await?;
    store.migrate().await?;
    Ok((store, url))
}
