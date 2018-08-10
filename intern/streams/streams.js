import stream from "stream"
import _ from "underscore"
import HLSHandler from "./hls"
import DASHHandler from "./dash"

if (config.geoservices && config.geoservices.enabled && !global.maxmind) {
    global.maxmind = require("maxmind").open(global.config.geoservices.maxmindDatabase)
    if (!maxmind) {
        console.log("Error loading Maxmind Database")
    }
}

let configFileInfo = {} // {streamname:conf}
let streamID = {} // id:streamname
let inputStreams = {} // {streamname:stream}
let streams = {} // {streamname:stream}
let streamConf = {} // {streamname:{conf}}
let streamPasswords = {} // {pass:Stream}
let streamMetadata = {} // {streamname:{Meta}}
let streamPastMetadata = {} // {streamname:[{Meta}]}
let streamListeners = {} // {stream:[{listener}]}
let streamPreBuffer = {} // {stream:prebuffer}
let rateLimitBuffer = {} // {stream:[buffers]}
let rateLimitingIsEnabled = false
let primaryStream = ""
let latestListenerID = {} // {stream:id}

if (global.config.hls || global.config.dash) {
    var hlsLastHit = {} // {stream:{id:unixtime}}
    var hlsHanders = {} // {stream:[handler]}
    var dashHanders = {} // {stream:[handler]}

    // handle HLS hits
    setInterval(() => {
        let now = Math.round((new Date()).getTime() / 1000)
        for (let id in streams) {
            if (streams.hasOwnProperty(id)) {
                let listeners = getListeners(id)
                for (let lid in listeners) {
                    if (listeners.hasOwnProperty(lid)) {
                        if (listeners[lid].hls) {
                            if (!hlsLastHit[id]) {
                                hlsLastHit[id] = {}
                            }
                            if (!hlsLastHit[id][listeners[lid].id]) {
                                hlsLastHit[id][listeners[lid].id] = now
                            }
                            if (hlsLastHit[id][listeners[lid].id] < now - 20 ) {
                                listenerTunedOut(id, listeners[lid].id)
                            }
                        }
                    }
                }
            }
        }
    }, 1000)
}

const streamExists = function (streamname) {
    return streams.hasOwnProperty(streamname) && stream[streamname] !== null
}


/*
    Conf
    {
        stream: "streamname",
        name: "Stream Name",
        type: "Audio type in file Content-Type format eg. audio/mpeg"
    }
*/
const addStream = function (inputStream, conf) {
    if (!conf.stream) {
        throw new Error("Stream is null")
    }
    conf.name = conf.name || "Not available";
    streamPreBuffer[conf.stream] = []

    var throttleStream = new stream.PassThrough();
    throttleStream.setMaxListeners(0); // set soft max to prevent leaks
    streams[conf.stream] = throttleStream
    streamConf[conf.stream] = conf
    inputStreams[conf.stream] = inputStream

    throttleStream.on("error", (err) => {
        console.log("throttle stream error", err)
    })

    inputStream.on("error", (err) => {
        console.log("input stream error", err)
    })

    if (config.rateLimiting) {
        rateLimitingIsEnabled = true

        inputStreams[conf.stream].on("data", (chunk) => {
            if (!rateLimitBuffer[conf.stream]) {
                rateLimitBuffer[conf.stream] = []
            }
            rateLimitBuffer[conf.stream].push(chunk)
        });

        var rateLimitInterval = setInterval(() => {
            throttleStream.write(Buffer.concat(rateLimitBuffer[conf.stream]))
            rateLimitBuffer[conf.stream] = []
        }, 500)
    } else {
        inputStream.pipe(throttleStream);
    }

    if (global.config.hls) {
        hlsHanders[conf.stream] = new HLSHandler(inputStreams[conf.stream], conf.name)
        hlsHanders[conf.stream].start()
    }

    if (global.config.dash) {
        dashHanders[conf.stream] = new DASHHandler(inputStreams[conf.stream], conf.name)
        dashHanders[conf.stream].start()
    }


    throttleStream.on("data", (chunk) => {
        const newPreBuffer = []
        const currentLength = streamPreBuffer[conf.stream].length
        for (let i = (rateLimitingIsEnabled ? 10 : 100); i > 0; i--) {
            if (streamPreBuffer[conf.stream].hasOwnProperty(currentLength - i)) {
                newPreBuffer.push(streamPreBuffer[conf.stream][currentLength - i])
            }
        }
        newPreBuffer.push(chunk)
        streamPreBuffer[conf.stream] = newPreBuffer
    })

    inputStreams[conf.stream].on("end", () => {
        streamPreBuffer[conf.stream] = ""
        if (rateLimitingIsEnabled) {
            rateLimitBuffer[conf.stream] = []
            clearInterval(rateLimitInterval)
            clearInterval(hlsInterval)
        }
    })
    events.emit("addStream", conf.stream)

}

const getStream = (streamName) => {
    return streams[streamName]
}

const getStreamConf = (streamName) => {
    return streamConf[streamName]
}

const removeStream = (streamName) => {
    if (!streamName) {
        return;
    }
    streams = _.omit(streams, streamName)
    streamConf = _.omit(streamConf, streamName)
    streamMetadata = _.omit(streamMetadata, streamName)
  
    if (global.config.hls && hlsHanders[streamName]) {
        hlsHanders[streamName].stop()
    }
    if (global.config.dash && dashHanders[streamName]) {
        dashHanders[streamName].stop()
    }
    //streamListeners = _.omit(streamListeners, streamName)
    events.emit("removeStream", streamName)
}

const isStreamInUse = (streamName) => {
    return streams.hasOwnProperty(streamName)
}

const getStreamMetadata = (streamName) => {
    return streamMetadata[streamName] || {}
}
const setStreamMetadata = (streamName, data) => {
    if (config.disableMetadata) {
        return
    }
    if (config.antiStreamRipper) {
        setTimeout(setStreamMetadataNow, 1000 * (Math.random() * 10), streamName, data)
    } else {
        setStreamMetadataNow(streamName, data)
    }
}

const setStreamMetadataNow = (streamName, data) => {
    if (!isStreamInUse(streamName)) {
        return // prevents race conditions with anti-streamripper
    }
    data.time = Math.round((new Date()).getTime() / 1000)
    streamMetadata[streamName] = data
    if (typeof streamPastMetadata[streamName] === "undefined") {
        streamPastMetadata[streamName] = [data]
    } else {
        const newMeta = []
        newMeta.push(data)
        for (var i = 0; i < 19; i++) {
            if (streamPastMetadata[streamName].hasOwnProperty(i)) {
                newMeta.push(streamPastMetadata[streamName][i])
            }
        }
        streamPastMetadata[streamName] = newMeta
    }
    data.stream = streamName
    events.emit("metadata", data)
}

const getActiveStreams = () => {
    const returnStreams = []
    for (let id in streams) {
        if (streams.hasOwnProperty(id)) {
            returnStreams.push(id)
        }
    }
    returnStreams.sort()
    returnStreams.sort((a, b) => {
        return (a.replace(/\D/g, "")) - (b.replace(/\D/g, ""));
    })
    return returnStreams
}

const listenerTunedIn = (streamName, ip, client, starttime, hls) => {
    if (!streamListeners[streamName]) {
        streamListeners[streamName] = []
    }

    if (!latestListenerID[streamName]) {
        latestListenerID[streamName] = 0;
    }

    latestListenerID[streamName]++

    const info = {
        stream: streamName,
        ip: ip,
        client: client,
        starttime: starttime,
        hls: hls || false,
        id: latestListenerID[streamName],
    }
    if (config.geoservices && config.geoservices.enabled) {
        var ipInfo = global.maxmind.get(ip)
        if (ipInfo !== null && ipInfo.country) {
            info.country = ipInfo.country.names.en
            info.countryCode = ipInfo.country.iso_code
            info.location = {
                "latitude": ipInfo.location.latitude,
                "longitude": ipInfo.location.longitude,
                "accuracy": ipInfo.location.accuracy_radius,
            }
        }
    }

    streamListeners[streamName][info.id] = info
    events.emit("listenerTunedIn", _.clone(info))
    return info.id
}

const listenerTunedOut = (streamName, id) => {
    if (typeof id === "number" && streamListeners[streamName]) {
        const listener = _.clone(_.where(streamListeners[streamName], {id: id})[0] || {})
        streamListeners[streamName] = _.without(streamListeners[streamName], _.where(streamListeners[streamName], {id: id})[0])
        listener.id = id
        events.emit("listenerTunedOut", listener)
    }
}

const listenerIdExists = (streamName, id, ip, client) => {
    if (!streamListeners[streamName]) {
        return false
    }
    if (typeof id !== "number") {
        id = parseInt(id, 10)
    }
    const listener = _.findWhere(streamListeners[streamName], {id: id})
    if (!listener) {
        return false
    }
    if (listener.ip !== ip || listener.client !== client) {
        return false
    }
    return true
}

const getListeners = (streamName) => {
    if (!streamListeners[streamName]) {
        return []
    }
    return _.without(streamListeners[streamName], undefined)
}

const getUniqueListeners = (streamName) => {
    if (!streamListeners[streamName]) {
        return []
    }
    return _.uniq(getListeners(streamName), (item) => { 
        return item.stream + item.client + item.ip;
    })
}

const numberOfListerners = (streamName) => {
    if (config.hideListenerCount) {
        return 0
    }
    return getListeners(streamName).length
}

const numberOfUniqueListerners = (streamName) => {
    if (config.hideListenerCount) {
        return 0
    }
    return getListeners(streamName).length
}

const realNumberOfListerners = (streamName) => {
    return getListeners(streamName).length
}

const realNumberOfUniqueListerners = (streamName) => {
    return getListeners(streamName).length
}
const getPreBuffer = (streamName) => {
    return streamPreBuffer[streamName]
}

const getPastMedatada = (streamName) => {
    return streamPastMetadata[streamName]
}


const endStream = (streamName) => {
    if (isStreamInUse(streamName)) {
        inputStreams[stream].end();
    }
}

module.exports.addStream = addStream
module.exports.streamExists = streamExists
module.exports.getStream = getStream
module.exports.getStreamConf = getStreamConf
module.exports.streamPasswords = streamPasswords
module.exports.removeStream = removeStream
module.exports.isStreamInUse = isStreamInUse
module.exports.getStreamMetadata = getStreamMetadata
module.exports.setStreamMetadata = setStreamMetadata
module.exports.getActiveStreams = getActiveStreams
module.exports.primaryStream = primaryStream
module.exports.listenerTunedIn = listenerTunedIn
module.exports.listenerTunedOut = listenerTunedOut
module.exports.listenerIdExists = listenerIdExists
module.exports.getListeners = getListeners
module.exports.streamListeners = streamListeners
module.exports.getUniqueListeners = getUniqueListeners
module.exports.numberOfListerners = numberOfListerners
module.exports.numberOfUniqueListerners = numberOfUniqueListerners
module.exports.realNumberOfListerners = realNumberOfListerners
module.exports.realNumberOfUniqueListerners = realNumberOfUniqueListerners
module.exports.getPreBuffer = getPreBuffer
module.exports.getPastMedatada = getPastMedatada
module.exports.configFileInfo = configFileInfo
module.exports.streamID = streamID
module.exports.endStream = endStream
module.exports.hlsHanders = hlsHanders
module.exports.hlsLastHit = hlsLastHit
module.exports.dashHanders = dashHanders
