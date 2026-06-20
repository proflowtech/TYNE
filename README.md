# Tyne

Goal-enforcement layer for AI-assisted coding sessions.

Tyne keeps you on track during vibe coding by anchoring each session to a stated goal, creating an isolated git branch, and validating that your commits actually serve that goal before you merge.

## Usage

1. Open a git repository in VS Code
2. Click the Tyne icon in the activity bar
3. Fill in App, Task ID, and Goal
4. **Start Thread** — creates a `tyne/<taskId>-<goal>` branch
5. Code. Use **Save Stitch** to checkpoint commits
6. **Validate Goal** — confirms your work matches the stated goal
7. **Tie the Knot** — merges the thread when validation passes

## License

MIT
