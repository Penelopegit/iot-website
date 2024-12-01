require("dotenv").config()
const axios = require("axios")
const schedule = require("node-schedule")
const moment = require("moment")
const mongoose = require("mongoose")
mongoose.connect("mongodb://localhost:27017/sensors")

const lastSyncTimeSchema = new mongoose.Schema({
	syncObject: String, 
	unixtime: Number
})

const sensorsSchema = new mongoose.Schema({
    sender: String,
    topic: String,
    message: String,
    unixtime: Number,
    timestamp: { type : Date }
})
const sensorsModel = mongoose.model("sensors",sensorsSchema)
const lastSyncModel = mongoose.model("lastSync", lastSyncTimeSchema)

async function run() {
	const lastSyncTime = (await lastSyncModel.findOne({ syncObject: "THINGSBOARD" }))?.unixtime || 0 
	const currentSyncTime = moment.utc().format("x")
	const token = await authenticate()
	const customers = await getCustomers(token)
	const devices = (await Promise.all(customers.map(c => getDevicesForCustomer(c.id.id, token))))
						.map(r => r.data)
						.flat()
						.map(r => r.id.id)
	const deviceData = (await Promise.all(devices.map(d => getDataForDevice(d, token, lastSyncTime, currentSyncTime)))).flat()
	await writeToMongoDB(deviceData)
	await updateLastSyncTime(currentSyncTime)
	console.log("Done!", lastSyncTime, currentSyncTime)
}

async function writeToMongoDB(deviceData) {
	deviceData = deviceData.map(row => ({
		sender: row.device,
		topic: row.topic, 
		message: row.value, 
		unixtime: row.ts,
		timestamp: moment.utc(row.ts).format("YYYY-MM-DD HH:mm:ss")
	}))
	await sensorsModel.insertMany(deviceData)
}

async function updateLastSyncTime(currentSyncTime) {
	await lastSyncModel.findOneAndUpdate({ syncObject: "THINGSBOARD"}, {unixtime: currentSyncTime}, {
		new: true,
		upsert: true 
	});
}

async function authenticate() {
	try {
		const response = await axios.post(`${process.env.HOST}/api/auth/login`, {
			username: process.env.T_USERNAME,
			password: process.env.T_PASSWORD
		});
		const token = response.data.token;
		return token;
	} catch (error) {
		console.error('Authentication failed:', error);
		throw error;
	}
}

async function getCustomers(token) {
	try {
		const response = await axios.get(`${process.env.HOST}/api/customers?page=0&pageSize=1000`, {
			headers: {
				Authorization: `Bearer ${token}`
			}
		});
		return response.data.data
	} catch (error) {
		console.error('Failed to fetch customers:', error);
		throw error;
	}
}

async function getDevicesForCustomer(customerId, token) {
	try {
		const response = await axios.get(`${process.env.HOST}/api/customer/${customerId}/devices?page=0&pageSize=1000`, {
			headers: {
				Authorization: `Bearer ${token}`
			}
		});
		const devices = response.data;
		return devices;
	} catch (error) {
		console.error(`Failed to fetch devices for this customer ${customerId}:`, error);
		throw error;
	}
}

async function getDataForDevice(deviceId, token, lastSyncTime, currentSyncTime) {
	try {
		const keysResponse = await axios.get(`${process.env.HOST}/api/plugins/telemetry/DEVICE/${deviceId}/keys/timeseries`, {
			headers: {
				Authorization: `Bearer ${token}`
			}
		})
		const keys = keysResponse.data
		if (!keys.length) {
			return []
		}
		const response = await axios.get(`${process.env.HOST}/api/plugins/telemetry/DEVICE/${deviceId}/values/timeseries?keys=${keys.join(",")}&startTs=${lastSyncTime}&endTs=${currentSyncTime}`, {
			headers: {
				Authorization: `Bearer ${token}`
			}
		});
		const results = []
		const data = response.data
		for (var key in data) {
			if (data.hasOwnProperty(key)) {
				data[key].forEach(row => {
					results.push({
						device: deviceId,
						topic: key, 
						ts: row.ts, 
						value: row.value
					})
				})
			}
		}
		console.log("Device Data:", results)
		return results
	} catch (error) {
		console.error(`Failed to fetch data for device ${deviceId}:`, error);
		throw error;
	}
}

schedule.scheduleJob('*/1 * * * *', run)