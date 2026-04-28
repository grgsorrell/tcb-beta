"""Run the geographic validator battery 8 times in sequence and report
distribution + drifted-city details for failed cases."""
import json, re, subprocess, sys, time

# Re-use the existing test runner — invoke as a subprocess so each run
# is independent and we capture stdout per run.
RUNS = 8

FORBIDDEN = ["Altamonte Springs", "Sanford", "Casselberry", "Lake Mary",
             "Longwood", "Oviedo", "Winter Springs",
             # Osceola County
             "Buena Ventura Lakes", "Kissimmee", "St. Cloud", "Celebration",
             "Poinciana"]

def run_once():
    out = subprocess.run([sys.executable, "scripts/test_validator_multiturn.py"],
                         capture_output=True, text=True, timeout=600)
    txt = out.stdout
    # Extract per-conversation results from the "FINAL TEST RESULTS" section
    pass_count = 0
    fail_count = 0
    failures = []
    in_final = False
    for line in txt.splitlines():
        if "FINAL TEST RESULTS" in line:
            in_final = True
            continue
        if in_final:
            m = re.match(r"\s*\[(PASS|FAIL)\]\s+(.+)$", line)
            if m:
                if m.group(1) == "PASS": pass_count += 1
                else: fail_count += 1; failures.append(m.group(2).strip())
    # Detect drifted cities by scanning for "FORBIDDEN CITIES LEAKED" markers
    drifts = []
    for m in re.finditer(r"\*\*\* FORBIDDEN CITIES LEAKED:\s*(\[[^\]]*\])", txt):
        drifts.append(m.group(1))
    return pass_count, fail_count, failures, drifts


def main():
    out = open("scripts/geo_8x_output.txt", "w", encoding="utf-8", newline="\n")
    out.write("Geographic validator characterization — 8 sequential runs\n")
    out.write("=" * 70 + "\n\n")
    sums = []
    all_drifts = []
    for i in range(1, RUNS + 1):
        out.write(f"Run {i}: starting at {time.strftime('%H:%M:%S')}...\n")
        out.flush()
        try:
            p, f, failures, drifts = run_once()
        except Exception as e:
            out.write(f"  ERROR: {e}\n\n")
            continue
        sums.append(p)
        all_drifts.append(drifts)
        out.write(f"  Pass count: {p}/6\n")
        if failures:
            out.write(f"  Failed conversations: {failures}\n")
        if drifts:
            out.write(f"  Drifted cities: {drifts}\n")
        out.write("\n")
        out.flush()
    out.write("=" * 70 + "\n")
    out.write("DISTRIBUTION\n")
    out.write("=" * 70 + "\n")
    out.write(f"Pass counts per run: {sums}\n")
    avg = sum(sums) / len(sums) if sums else 0
    out.write(f"Average: {avg:.2f}/6\n")
    out.write(f"Min: {min(sums) if sums else 'n/a'}/6, Max: {max(sums) if sums else 'n/a'}/6\n")
    out.write(f"Threshold: avg >= 4.5/6 AND no run < 3/6\n")
    threshold_met = (avg >= 4.5) and (min(sums) >= 3 if sums else False)
    out.write(f"Threshold met: {threshold_met}\n\n")
    out.write("All drifted cities across all runs:\n")
    for i, d in enumerate(all_drifts, 1):
        out.write(f"  Run {i}: {d}\n")
    out.close()
    with open("scripts/geo_8x_output.txt", "r", encoding="utf-8") as f:
        sys.stdout.buffer.write(f.read().encode("utf-8"))


if __name__ == "__main__":
    main()
