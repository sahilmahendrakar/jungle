import express from "express";

const app = express();
const PORT = Number(process.env.PORT ?? 3001);

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "jungle-backend" });
});

app.listen(PORT, () => {
  console.log(`jungle-backend listening on http://localhost:${PORT}`);
});
