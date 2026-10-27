// Local dev entry. On Vercel the same app is served by api/index.js instead.
import app from './app.js';

const { PORT = 4000 } = process.env;
app.listen(PORT, () => console.log(`server on :${PORT}`));
