//! Sable's remote agent (see ../src/agent.rs): run by the app on an SSH
//! host, in WSL or in a container as `sable-agent --stdio`.

fn main() {
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        Some("--stdio") => {
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .expect("tokio runtime");
            runtime.block_on(sable_lib::agent::serve_stdio());
        }
        Some("--version") => println!("sable-agent {}", sable_lib::agent::VERSION),
        _ => {
            eprintln!("sable-agent {}: Sable's remote agent. The Sable app runs it as `sable-agent --stdio`.", sable_lib::agent::VERSION);
            std::process::exit(2);
        }
    }
}
