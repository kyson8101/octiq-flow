use super::*;
fn quote(value: &str, windows: bool) -> String {
    if windows {
        format!("'{}'", value.replace('\'', "''"))
    } else {
        crate::agent_provider::sh_quote(value)
    }
}
/// Pure generator: platform comes from the report, never from this machine.
pub(super) fn generate(items: &[&Item], windows: bool, allow_rm: bool) -> String {
    let mut s = if windows {
        "# Run this script yourself after reviewing every selected item.\n$ErrorActionPreference = 'Stop'\n$LASTEXITCODE = 0\n".to_string()
    } else {
        "#!/usr/bin/env bash\nset -euo pipefail\n# Run this script yourself after reviewing every selected item.\n".to_string()
    };
    let echo = |text: &str| {
        if windows {
            format!("Write-Output {}\n", quote(text, true))
        } else {
            format!("printf '%s\\n' {}\n", quote(text, false))
        }
    };
    s.push_str(&echo("Selected cleanup actions:"));
    for i in items {
        s.push_str(&echo(&format!(
            "{} — {} ({} bytes)",
            i.label, i.path, i.bytes
        )));
    }
    s.push_str(if windows {
        "if ((Read-Host 'Type exactly yes to continue') -cne 'yes') { exit 0 }\n"
    } else {
        "read -r -p 'Type exactly yes to continue: ' answer\n[[ \"$answer\" == yes ]] || exit 0\n"
    });
    for item in items {
        s.push_str(&echo(&format!("{}: {}", item.label, item.effect)));
        match &item.action {
            Some(Action::Tool { command } | Action::Docker { command }) => {
                s.push_str(command);
                s.push('\n');
            }
            Some(Action::Worktree { repo, path }) => {
                s.push_str(&echo("Warning: .gitignore-ignored output that exists only in this worktree is deleted too."));
                s.push_str(&format!(
                    "git -C {} worktree remove {}\n",
                    quote(repo, windows),
                    quote(path, windows)
                ));
            }
            Some(Action::Rm { path }) if allow_rm => {
                if windows {
                    s.push_str(&format!("if (Test-Path -LiteralPath {}) {{\n  $target = Get-Item -Force -LiteralPath {}\n  if ($target.Attributes -band [IO.FileAttributes]::ReparsePoint) {{ throw 'Refusing reparse point' }}\n  Remove-Item -LiteralPath {} -Recurse -Force\n}}\n",quote(path,true),quote(path,true),quote(path,true)));
                } else {
                    s.push_str(&format!("rm -rf -- {}\n", quote(path, false)));
                }
            }
            Some(Action::RmOlderThan {
                path,
                days,
                exclude,
            }) if allow_rm => {
                if windows {
                    // Explicit stack: Get-ChildItem -Recurse can enter junctions on older PowerShell.
                    s.push_str(&format!("$root = {}\n$cutoff = [DateTime]::UtcNow.AddDays(-{})\n$exclude = @({})\n$pending = [Collections.Generic.Stack[string]]::new()\n$pending.Push($root)\nwhile ($pending.Count -gt 0) {{\n  $dir = $pending.Pop()\n  $meta = Get-Item -LiteralPath $dir -Force\n  if ($meta.Attributes -band [IO.FileAttributes]::ReparsePoint) {{ continue }}\n  foreach ($entry in (Get-ChildItem -LiteralPath $dir -Force)) {{\n    if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) {{ continue }}\n    if ($entry.Name -ieq 'memory' -or $exclude -contains $entry.FullName) {{ continue }}\n    if ($entry.PSIsContainer) {{ $pending.Push($entry.FullName) }}\n    elseif ($entry.LastWriteTimeUtc -lt $cutoff) {{ Remove-Item -LiteralPath $entry.FullName -Force }}\n  }}\n}}\n",quote(path,true),days,exclude.iter().map(|x|quote(x,true)).collect::<Vec<_>>().join(", ")));
                } else {
                    let mut prune = String::from("-iname 'memory'");
                    for p in exclude {
                        prune.push_str(&format!(" -o -path {}", quote(p, false)));
                    }
                    // -mmin avoids find -mtime's full-day rounding; -P is the no-follow default.
                    s.push_str(&format!("find -P {} -xdev \\( -type d \\( {} \\) -prune \\) -o \\( -type f -mmin +{} -exec rm -f -- {{}} + \\)\n",quote(path,false),prune,(*days as u64)*1440));
                }
            }
            Some(Action::Rm { path } | Action::RmOlderThan { path, .. }) => {
                s.push_str(&echo(&format!("Skipped (no tool command): {path}")))
            }
            None => {}
        }
        if windows {
            s.push_str(
                "if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { throw 'Cleanup command failed' }\n",
            );
        }
    }
    s
}
