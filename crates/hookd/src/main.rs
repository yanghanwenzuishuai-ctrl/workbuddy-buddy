//! wb-buddy-hookd — headless daemon. Tails the event spool via wb-buddy-watch and
//! prints the pet's display state to stdout on every change (one word per line).
//! Useful for debugging, terminal demos, and piping into other tools.

use std::io::Write;

fn main() {
    let spool = wb_buddy_watch::default_spool();
    eprintln!("[wb-buddy-hookd] tailing {}", spool.display());
    wb_buddy_watch::run(&spool, |state| {
        let mut out = std::io::stdout().lock();
        let _ = writeln!(out, "{}", state.as_str());
        let _ = out.flush(); // real-time even when stdout is a pipe; ignore broken pipe
    });
}
