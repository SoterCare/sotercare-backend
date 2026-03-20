const { io } = require("socket.io-client");
const socket = io("https://backend.sotercare.com/realtime", { transports: ["websocket"] });
const t = setTimeout(() => { console.error("timeout"); socket.close(); process.exit(1); }, 15000);
socket.on("connect", () => {
  socket.emit("device_auth", {
    device_id: "pi-ffc585939c23",
    device_key: "TW3DNioQHndfvbcIyVex2KqBCJFwjZuOpPsEYa15",
    timestamp: Date.now(),
  }, (authAck) => {
    console.log("authAck", JSON.stringify(authAck));
    socket.emit("device_data", {
      logs: [{ temp: 37.1, ambientTemp: 25.0, moisture: 2, gait_label: "sitting", sos_trigger: false, fall_alert: false, unix_timestamp: Math.floor(Date.now()/1000) }]
    }, (dataAck) => {
      console.log("dataAck", JSON.stringify(dataAck));
      clearTimeout(t);
      socket.close();
      process.exit(0);
    });
  });
});
socket.on("exception", (e) => console.error("exception", JSON.stringify(e)));
socket.on("connect_error", (e) => console.error("connect_error", e.message));
