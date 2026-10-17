//! `octiq-job`: run a long command and show its progress in its OctiqFlow
//! chat. All of it is `octiq_flow_lib::job_wrapper` (see `docs/jobs.md`);
//! agents reach the same code as `octiq-server job` through `OCTIQ_JOB`.

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    std::process::exit(octiq_flow_lib::job_wrapper::main(args));
}
