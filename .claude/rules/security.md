# Security Rules (MANDATORY)

## Environment Files
- NEVER read, cat, head, tail, grep, or access any .env file
- NEVER print, log, or display environment variable values
- NEVER include secrets in code, comments, or commit messages
- If you need to know what env vars exist, ask the user — do not look

## API Keys
- All API keys are managed via Vercel environment variables
- Client-side code must NEVER contain API keys
- Serverless functions in /api/ access keys via process.env (this is safe)

## Git
- .env must always be in .gitignore
- Never commit .env files
- Never commit files containing secrets
