fn main() -> anyhow::Result<()> {
    ink_tools::cli::run(std::env::args().skip(1).collect())
}
