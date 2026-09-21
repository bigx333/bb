const response = http.post("http://127.0.0.1:41998/__timeout/" + TIMEOUT_ACTION, {
  body: "",
});
if (!response.ok) throw new Error("Timeout control failed: " + response.status);
