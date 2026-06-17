let _io = null;

const init = (io) => { _io = io; };
const getIO = () => _io;
const emitToRoom = (room, event, data) => { if (_io) _io.to(room).emit(event, data); };

module.exports = { init, getIO, emitToRoom };
