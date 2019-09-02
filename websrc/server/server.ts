import { MsgAttachGadgetToHook, MsgDetachGadgetFromHook, MsgMasterStartGadget, MsgSaveSettings } from './../common/aardvark-react/aardvark_protocol';
import { MsgGetGadgetManifest, MsgGetGadgetManifestResponse, MsgUpdateSceneGraph, EndpointAddr, endpointAddrToString, MsgGrabEvent, endpointAddrsMatch, MsgGrabberState, MsgGadgetStarted, MsgSetEndpointTypeResponse, MsgPokerProximity, MsgMouseEvent, MsgNodeHaptic } from 'common/aardvark-react/aardvark_protocol';
import { MessageType, EndpointType, MsgSetEndpointType, Envelope, MsgNewEndpoint, MsgLostEndpoint, parseEnvelope, MsgError } from 'common/aardvark-react/aardvark_protocol';
import { AvGadgetManifest, AvNode, AvNodeType, AvGrabEvent, AvGrabEventType } from 'common/aardvark';
import * as express from 'express';
import * as http from 'http';
import * as WebSocket from 'ws';
import bind from 'bind-decorator';
import axios, { AxiosResponse } from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { URL } from 'url';
import * as fileUrl from 'file-url';
import { persistence, StoredGadget } from './persistence';

let g_localInstallPathUri = fileUrl( path.resolve( process.cwd() ));
console.log( "Data directory is", g_localInstallPathUri );

function fixupUriForLocalInstall( originalUri: string ):URL
{
	let lowerUri = originalUri.toLowerCase();

	let httpPrefix = "http://aardvark.install";
	let httpsPrefix = "https://aardvark.install";

	if ( lowerUri.indexOf( httpPrefix ) == 0 )
	{
		return new URL( g_localInstallPathUri + originalUri.slice( httpPrefix.length ) );
	}
	else
	{
		if ( lowerUri.indexOf( httpsPrefix ) == 0 )
		{
			return new URL( g_localInstallPathUri + originalUri.slice( httpsPrefix.length ) );
		}
	}

	return new URL( originalUri );
}

function getJSONFromUri( uri: string ): Promise< any >
{
	return new Promise<any>( ( resolve, reject ) =>
	{
		try
		{
			let url = fixupUriForLocalInstall( uri );
			if( url.protocol == "file:" )
			{
				fs.readFile( url, "utf8", (err: NodeJS.ErrnoException, data: string ) =>
				{
					if( err )
					{
						reject( err );
					}
					else
					{
						resolve( JSON.parse( data ) );
					}
				});
			}
			else
			{
				let promRequest = axios.get( url.toString() )
				.then( (value: AxiosResponse ) =>
				{
					resolve( value.data );
				} )
				.catch( (reason: any ) =>
				{
					reject( reason );
				});
			}
		}
		catch( e )
		{
			reject( e );
		}
	} );
}


function buildPersistentHookPath( gadgetUuid: string, hookPersistentName: string )
{
	return "/gadget/" + gadgetUuid + "/" + hookPersistentName;
}

interface HookPathParts
{
	gadgetUuid: string;
	hookPersistentName: string;
}

function parsePersistentHookPath( path: string ): HookPathParts
{
	let re = new RegExp( "^/gadget/(.*)/(.*)$" );
	let match = re.exec( path );
	if( !match )
	{
		// this probably isn't a gadget hook path
		return null;
	}

	return (
		{ 
			gadgetUuid: match[1],
			hookPersistentName: match[2],
		} );
}

interface GadgetToStart
{
	storedData: StoredGadget;
	hookPath: string;
}

class CDispatcher
{
	private m_endpoints: { [connectionId: number ]: CEndpoint } = {};
	private m_monitors: CEndpoint[] = [];
	private m_renderers: CEndpoint[] = [];
	private m_gadgets: CEndpoint[] = [];
	private m_gadgetsByUuid: { [ uuid: string ] : CEndpoint } = {};

	constructor()
	{
	}

	private getListForType( ept: EndpointType )
	{
		switch( ept )
		{
			case EndpointType.Gadget:
				return this.m_gadgets;

			case EndpointType.Monitor:
				return this.m_monitors;

			case EndpointType.Renderer:
				return this.m_renderers;
		}

		return null;
	}

	public addPendingEndpoint( ep: CEndpoint )
	{
		this.m_endpoints[ ep.getId() ] = ep;
	}

	public setEndpointType( ep: CEndpoint )
	{
		let list = this.getListForType( ep.getType() );
		if( list )
		{
			list.push( ep );
		}

		if( ep.getType() == EndpointType.Monitor )
		{
			this.sendStateToMonitor( ep );
		}
		else if( ep.getType() == EndpointType.Renderer )
		{
			// tell the renderer about everybody's scene graphs
			for( let epid in this.m_endpoints )
			{
				let existingEp = this.m_endpoints[ epid ];
				if( existingEp.getType() == EndpointType.Gadget )
				{
					let gadgetData = existingEp.getGadgetData();
					if( gadgetData )
					{
						ep.sendMessageString(
							this.buildPackedEnvelope( 
								this.buildUpdateSceneGraphMessage( existingEp.getId(), gadgetData.getRoot(), gadgetData.getHook() ) ) );
					}
				}
			}
		}

		if( ep.getGadgetData() )
		{
			this.m_gadgetsByUuid[ ep.getGadgetData().getPersistenceUuid() ] = ep;
		}
	}

	public sendToMaster( type: MessageType, m: any )
	{
		let ep = this.m_gadgetsByUuid[ "master" ];
		if( ep )
		{
			ep.sendMessage( type, m );
		}
		else
		{
			console.log( "Tried to send message to master, but there is no master gadget endpoint" );
		}
	}

	public removeEndpoint( ep: CEndpoint )
	{
		let list = this.getListForType( ep.getType() );
		if( list )
		{
			let i = list.indexOf( ep );
			if( i != -1 )
			{
				list.splice( i, 1 );
			}
		}
		delete this.m_endpoints[ ep.getId() ];

		if( ep.getGadgetData() )
		{
			delete this.m_gadgetsByUuid[ ep.getGadgetData().getPersistenceUuid() ];
		}
	}

	private sendStateToMonitor( targetEp: CEndpoint )
	{
		for( let epid in this.m_endpoints )
		{
			let ep = this.m_endpoints[ epid ];
			switch( ep.getType() )
			{
				case EndpointType.Gadget:
					targetEp.sendMessageString( 
						this.buildPackedEnvelope( 
							this.buildNewEndpointMessage( ep ) ) );

					let gadgetData = ep.getGadgetData();
					if( gadgetData )
					{
						targetEp.sendMessageString(
							this.buildPackedEnvelope( 
								this.buildUpdateSceneGraphMessage( ep.getId(), gadgetData.getRoot(), gadgetData.getHook() ) ) );
					}
					break;

				case EndpointType.Renderer:
					targetEp.sendMessageString( 
						this.buildPackedEnvelope( 
							this.buildNewEndpointMessage( ep ) ) );
					break;
			}
		}
	}

	public buildPackedEnvelope( env: Envelope )
	{
		if( !env.payloadUnpacked )
		{
			return JSON.stringify( env );
		}
		else 
		{
			let packedEnv: Envelope =
			{
				type: env.type,
				sender: env.sender,
				target: env.target,
			}

			if( env.payloadUnpacked )
			{
				packedEnv.payload = JSON.stringify( env.payloadUnpacked );
			}
			return JSON.stringify( packedEnv );
		}
	}


	public sendToAllEndpointsOfType( ept: EndpointType, env: Envelope )
	{
		let list = this.getListForType( ept );
		if( list )
		{
			let msgString = this.buildPackedEnvelope( env );

			for( let ep of list )
			{
				ep.sendMessageString( msgString );
			}
		}
	}

	public updateGadgetSceneGraph( gadgetId: number, root: AvNode, hook: string | EndpointAddr )
	{
		let env = this.buildUpdateSceneGraphMessage( gadgetId, root, hook );
		this.sendToAllEndpointsOfType( EndpointType.Monitor, env );
		this.sendToAllEndpointsOfType( EndpointType.Renderer, env );
	}

	private buildUpdateSceneGraphMessage( gadgetId: number, root: AvNode, 
		hook: string | EndpointAddr ): Envelope
	{
		let msg: MsgUpdateSceneGraph = 
		{
			root,
			hook,
		};
		return (
		{
			type: MessageType.UpdateSceneGraph,
			sender: { type: EndpointType.Gadget, endpointId: gadgetId },
			payloadUnpacked: msg,
		} );
	}


	public buildNewEndpointMessage( ep: CEndpoint ): Envelope
	{
		let newEpMsg: MsgNewEndpoint =
		{
			newEndpointType: ep.getType(),
			endpointId: ep.getId(),
		}

		if( ep.getGadgetData() )
		{
			newEpMsg.gadgetUri = ep.getGadgetData().getUri();
		}

		return (
		{
			sender: { type: EndpointType.Hub },
			type: MessageType.NewEndpoint,
			payloadUnpacked: newEpMsg,
		} );
	}

	public forwardToEndpoint( epa: EndpointAddr, env: Envelope )
	{
		if( endpointAddrsMatch( epa, env.sender ) )
		{
			// don't forward messages back to whomever just sent them
			return;
		}

		let ep = this.m_endpoints[ epa.endpointId ];
		if( !ep )
		{
			console.log( "Sending message to unknown endpoint " + endpointAddrToString( epa ) );
			return;
		}

		ep.sendMessage( env.type, env.payloadUnpacked, epa, env.sender );
	}

	public forwardToHookNodes( env: Envelope )
	{
		for( let gadget of this.m_gadgets )
		{
			let hookNodes = gadget.getGadgetData().getHookNodes();
			if( !hookNodes )
				continue;
			
			for( let hookData of hookNodes )
			{
				this.forwardToEndpoint( hookData.epa, env );
			}
		}
	}

	public getGadgetEndpoint( gadgetId: number ) : CEndpoint
	{
		let ep = this.m_endpoints[ gadgetId ];
		if( ep && ep.getType() == EndpointType.Gadget )
		{
			return ep;
		}
		else
		{
			return null;
		}
	}

	public getPersistentNodePath( hookId: EndpointAddr )
	{
		let gadget = this.getGadgetEndpoint( hookId.endpointId );
		if( gadget )
		{
			return gadget.getGadgetData().getPersistentNodePath( hookId );
		}
		else
		{
			return null;
		}
	}

	public tellMasterToStartGadget( uri: string, initalHook: string, persistenceUuid: string )
	{
		if( !this.m_gadgetsByUuid[ persistenceUuid ] )
		{
			// we don't have one of these gadgets yet, so tell master to start one
			let msg: MsgMasterStartGadget =
			{
				uri: uri,
				initialHook: initalHook,
				persistenceUuid: persistenceUuid,
			} 

			this.sendToMaster( MessageType.MasterStartGadget, msg );
		}
	}

	public findHook( hookInfo:HookPathParts ): EndpointAddr
	{
		let gadgetEp = this.m_gadgetsByUuid[ hookInfo.gadgetUuid ];
		if( gadgetEp )
		{
			return gadgetEp.getGadgetData().getHookNodeByPersistentName( hookInfo.hookPersistentName );
		}
		else
		{
			return null;
		}
	}

}

interface HookNodeData
{
	epa: EndpointAddr;
	persistentName: string;
}

class CGadgetData
{
	private m_gadgetUri: string;
	private m_ep: CEndpoint;
	private m_manifest: AvGadgetManifest = null;
	private m_root: AvNode = null;
	private m_hook: string | EndpointAddr = null;
	private m_mainGrabbable: EndpointAddr = null;
	private m_persistenceUuid: string = null;
	private m_dispatcher: CDispatcher = null;
	private m_hookNodes:HookNodeData[] = [];

	constructor( ep: CEndpoint, uri: string, initialHook: string, persistenceUuid:string,
		dispatcher: CDispatcher )
	{
		if( persistenceUuid )
		{
			if( !initialHook )
			{
				initialHook = persistence.getGadgetHook( persistenceUuid );
			}

			this.m_persistenceUuid = persistenceUuid;
		}
		else
		{
			this.m_persistenceUuid = persistence.createGadgetPersistence( uri );
			if( initialHook )
			{
				persistence.setGadgetHook( this.m_persistenceUuid, initialHook );
			}
		}

		this.m_ep = ep;
		this.m_gadgetUri = uri;
		this.m_dispatcher = dispatcher;

		let hookInfo = parsePersistentHookPath( initialHook );
		if( !hookInfo )
		{
			// must not be a gadget hook
			this.m_hook = initialHook;
		}
		else
		{
			let hookAddr = this.m_dispatcher.findHook( hookInfo );
			if( !hookAddr )
			{
				console.log( `Expected to find hook ${ initialHook } for ${ this.m_ep.getId() }` );
			}
			else
			{
				this.m_hook = hookAddr;
			}
		}


		getJSONFromUri( this.m_gadgetUri + "/gadget_manifest.json")
		.then( ( response: any ) => 
		{
			this.m_manifest = response as AvGadgetManifest;
			console.log( `Gadget ${ this.m_ep.getId() } is ${ this.getName() }` );
		})
		.catch( (reason: any ) =>
		{
			console.log( `failed to load manifest from ${ this.m_gadgetUri }`, reason );
			this.m_ep.close();
		})
	}

	public getUri() { return this.m_gadgetUri; }
	public getName() { return this.m_manifest.name; }
	public getRoot() { return this.m_root; }
	public getHook() { return this.m_hook; }
	public getHookNodes() { return this.m_hookNodes; }
	public getPersistenceUuid() { return this.m_persistenceUuid; }
	public isMaster() { return this.m_persistenceUuid == "master"; }

	public getHookNodeByPersistentName( hookPersistentName: string )
	{
		for( let hook of this.m_hookNodes )
		{
			if( hook.persistentName == hookPersistentName )
			{
				return hook.epa;
			}
		}

		return null;
	}


	public updateSceneGraph( root: AvNode ) 
	{
		let firstUpdate = this.m_root == null;

		this.m_root = root;

		let hookToSend = this.m_hook;
		if( !firstUpdate )
		{
			// Only send endpoint hooks once so the main grabbable
			// can actually be grabbed.
			if( typeof this.m_hook !== "string" )
			{
				hookToSend = null;
			}
		}

		this.m_dispatcher.updateGadgetSceneGraph( this.m_ep.getId(), this.m_root, hookToSend );

		this.m_hookNodes = [];
		this.m_mainGrabbable = null;
		this.updateHookNodeList( root );

		if( firstUpdate )
		{
			// make sure the hook knows this thing is on it and that this thing knows it's
			// on the hook
			if( this.m_hook && typeof this.m_hook !== "string" )
			{
				if( this.m_mainGrabbable == null )
				{
					console.log( `Gadget ${ this.m_ep.getId() } is on a hook but`
						+ ` doesn't have a main grabbable` );
					this.m_hook = null;
				}
				else
				{
					let event: AvGrabEvent =
					{
						type: AvGrabEventType.EndGrab,
						hookId: this.m_hook,
						grabbableId: this.m_mainGrabbable,
					};

					let msg: MsgGrabEvent =
					{
						event,
					}

					let env: Envelope =
					{
						type: MessageType.GrabEvent,
						payloadUnpacked: msg,
					}

					this.m_dispatcher.forwardToEndpoint( this.m_hook, env );
					this.m_dispatcher.forwardToEndpoint( this.m_mainGrabbable, env );
				}
			}

			let gadgetsToStart = persistence.getGadgets();
			for( let gadget of gadgetsToStart )
			{
				let gadgetHook = persistence.getGadgetHook( gadget.uuid );
				let hookParts = parsePersistentHookPath( gadgetHook )
				if( !hookParts && this.isMaster() 
					|| hookParts && hookParts.gadgetUuid == this.getPersistenceUuid() )
				{
					this.m_dispatcher.tellMasterToStartGadget( gadget.uri, gadgetHook, gadget.uuid );
				}
			}
		}
	}

	private updateHookNodeList( node: AvNode )
	{
		if( !node )
			return;

		if( node.type == AvNodeType.Hook )
		{
			this.m_hookNodes.push(
				{ 
					epa:
					{
						endpointId: this.m_ep.getId(),
						type: EndpointType.Node,
						nodeId: node.id,
					},
					persistentName: node.persistentName,
				}
			)
		}
		else if( node.type == AvNodeType.Grabbable )
		{
			if( !this.m_mainGrabbable )
			{
				this.m_mainGrabbable = 
				{
					endpointId: this.m_ep.getId(),
					type: EndpointType.Node,
					nodeId: node.id,
				};
			}
		}

		if( node.children )
		{
			for( let child of node.children )
			{
				this.updateHookNodeList( child );
			}
		}
	}

	public getPersistentNodePath( hookId: EndpointAddr )
	{
		for( let hookData of this.m_hookNodes )
		{
			if( hookData.epa.nodeId == hookId.nodeId )
			{
				return buildPersistentHookPath( this.m_persistenceUuid, hookData.persistentName );
			}
		}
		return null;
	}

}

interface EnvelopeHandler
{
	(env: Envelope, m: any): void;
}

class CEndpoint
{
	private m_ws: WebSocket = null;
	private m_id: number;
	private m_type = EndpointType.Unknown;
	private m_dispatcher: CDispatcher = null;
	private m_gadgetData: CGadgetData = null;
	private m_envelopeHandlers: { [ type:number]: EnvelopeHandler } = {}

	constructor( ws: WebSocket, id: number, dispatcher: CDispatcher )
	{
		console.log( "new connection");
		this.m_ws = ws;
		this.m_id = id;
		this.m_dispatcher = dispatcher;

		ws.on( 'message', this.onMessage );
		ws.on( 'close', this.onClose );

		this.registerEnvelopeHandler( MessageType.SetEndpointType, this.onSetEndpointType );
		this.registerEnvelopeHandler( MessageType.GetGadgetManifest, this.onGetGadgetManifest );
		this.registerEnvelopeHandler( MessageType.UpdateSceneGraph, this.onUpdateSceneGraph );
		this.registerEnvelopeHandler( MessageType.GrabberState, this.onGrabberState );
		this.registerEnvelopeHandler( MessageType.GrabEvent, this.onGrabEvent );
		this.registerEnvelopeHandler( MessageType.GadgetStarted, this.onGadgetStarted );
		this.registerEnvelopeHandler( MessageType.PokerProximity, this.onPokerProximity );
		this.registerEnvelopeHandler( MessageType.MouseEvent, this.onMouseEvent );
		this.registerEnvelopeHandler( MessageType.NodeHaptic, this.onNodeHaptic );
		this.registerEnvelopeHandler( MessageType.AttachGadgetToHook, this.onAttachGadgetToHook );
		this.registerEnvelopeHandler( MessageType.DetachGadgetFromHook, this.onDetachGadgetFromHook );
		this.registerEnvelopeHandler( MessageType.SaveSettings, this.onSaveSettings );
	}

	public getId() { return this.m_id; }
	public getType() { return this.m_type; }
	public getGadgetData() { return this.m_gadgetData; }

	private registerEnvelopeHandler( type: MessageType, handler: EnvelopeHandler )
	{
		this.m_envelopeHandlers[ type as number ] = handler;
	}

	private callEnvelopeHandler( env: Envelope ): boolean
	{
		let handler = this.m_envelopeHandlers[ env.type as number ];
		if( handler )
		{
			handler( env, env.payloadUnpacked );
			return true;
		}
		else
		{
			return false;
		}
	}

	@bind onMessage( message: string )
	{
		let env:Envelope = parseEnvelope( message );
		if( !env )
		{
			return;
		}

		env.sender = { type: this.m_type, endpointId: this.m_id };

		if( this.m_type == EndpointType.Unknown )
		{
			if( env.type != MessageType.SetEndpointType )
			{
				this.sendError( "SetEndpointType must be the first message from an endpoint" );
				return;
			}
		}
		else if( env.type == MessageType.SetEndpointType )
		{
			this.sendError( "SetEndpointType may only be sent once", MessageType.SetEndpointType );
			return;
		}

		if( !this.callEnvelopeHandler( env ) )
		{
			this.sendError( "Unsupported message", env.type );
		}

	}

	@bind private onGetGadgetManifest( env: Envelope, m: MsgGetGadgetManifest )
	{
		getJSONFromUri( m.gadgetUri + "/gadget_manifest.json" )
		.then( ( jsonManifest: any ) =>
		{
			let response: MsgGetGadgetManifestResponse =
			{
				manifest: jsonManifest as AvGadgetManifest,
				gadgetUri: m.gadgetUri,
			}
			this.sendMessage( MessageType.GetGadgetManifestResponse, response );
		})
		.catch( (reason:any ) =>
		{
			let response: MsgGetGadgetManifestResponse =
			{
				error: "Unable to load manifest " + reason,
				gadgetUri: m.gadgetUri,
			}
			this.sendMessage( MessageType.GetGadgetManifestResponse, response );
		})

	}

	@bind private onUpdateSceneGraph( env: Envelope, m: MsgUpdateSceneGraph )
	{
		if( !this.m_gadgetData )
		{
			this.sendError( "Only valid from gadgets", MessageType.UpdateSceneGraph );
			return;
		}

		this.m_gadgetData.updateSceneGraph( m.root );
	}


	@bind private onSetEndpointType( env: Envelope, m: MsgSetEndpointType )
	{
		switch( m.newEndpointType )
		{
			case EndpointType.Gadget:
				if( !m.gadgetUri )
				{
					this.sendError( "SetEndpointType to gadget must provide URI",
						MessageType.SetEndpointType );
						return;
				}
				break;

			case EndpointType.Monitor:
			case EndpointType.Renderer:
				break;

			default:
				this.sendError( "New endpoint type must be Gadget, Monitor, or Renderer", 
					MessageType.SetEndpointType );
				return;

		}

		console.log( `Setting endpoint ${ this.m_id } to ${ EndpointType[ m.newEndpointType ]}` );
		this.m_type = m.newEndpointType;

		let msgResponse: MsgSetEndpointTypeResponse =
		{
			endpointId: this.m_id,
		}

		if( this.getType() == EndpointType.Gadget )
		{
			console.log( " initial hook is " + m.initialHook );
			this.m_gadgetData = new CGadgetData( this, m.gadgetUri, m.initialHook, m.persistenceUuid,
				this.m_dispatcher );

			let settings = persistence.getGadgetSettings( this.m_gadgetData.getPersistenceUuid() );
			if( settings )
			{
				msgResponse.settings = settings;
			}
		}


		this.sendMessage( MessageType.SetEndpointTypeResponse, msgResponse );
		
		this.m_dispatcher.setEndpointType( this );

		this.m_dispatcher.sendToAllEndpointsOfType( EndpointType.Monitor,
			this.m_dispatcher.buildNewEndpointMessage( this ) );
	}

	@bind private onGrabberState( env: Envelope, m: MsgGrabberState )
	{
		this.m_dispatcher.forwardToEndpoint( m.grabberId, env );
		this.m_dispatcher.sendToAllEndpointsOfType( EndpointType.Monitor, env );
	}

	@bind private onPokerProximity( env: Envelope, m: MsgPokerProximity )
	{
		this.m_dispatcher.forwardToEndpoint( m.pokerId, env );
		this.m_dispatcher.sendToAllEndpointsOfType( EndpointType.Monitor, env );
	}

	@bind private onMouseEvent( env: Envelope, m: MsgMouseEvent )
	{
		this.m_dispatcher.forwardToEndpoint( m.event.panelId, env );
		this.m_dispatcher.sendToAllEndpointsOfType( EndpointType.Monitor, env );
	}

	@bind private onNodeHaptic( env: Envelope, m: MsgNodeHaptic )
	{
		this.m_dispatcher.sendToAllEndpointsOfType( EndpointType.Monitor, env );
		this.m_dispatcher.sendToAllEndpointsOfType( EndpointType.Renderer, env );
	}

	@bind private onGrabEvent( env: Envelope, m: MsgGrabEvent )
	{
		if( m.event.grabberId )
		{
			this.m_dispatcher.forwardToEndpoint( m.event.grabberId, env );
		}
		if( m.event.grabbableId )
		{
			this.m_dispatcher.forwardToEndpoint( m.event.grabbableId, env );
		}
		if( m.event.hookId )
		{
			this.m_dispatcher.forwardToEndpoint( m.event.hookId, env );
		}

		if( m.event.type == AvGrabEventType.StartGrab || m.event.type == AvGrabEventType.EndGrab )
		{
			// start and end grab events also go to all hooks so they can highlight
			this.m_dispatcher.forwardToHookNodes( env );
		}

		if( env.sender.type != EndpointType.Renderer )
		{
			this.m_dispatcher.sendToAllEndpointsOfType( EndpointType.Renderer, env );
		}
		this.m_dispatcher.sendToAllEndpointsOfType( EndpointType.Monitor, env );
	}

	@bind private onGadgetStarted( env:Envelope, m: MsgGadgetStarted )
	{
		if( m.mainGrabbable )
		{
			m.mainGrabbableGlobalId = 
			{ 
				type: EndpointType.Node, 
				endpointId: this.m_id,
				nodeId: m.mainGrabbable,
			};
		}

		this.m_dispatcher.forwardToEndpoint( m.epToNotify, env );
	}

	@bind private onAttachGadgetToHook( env: Envelope, m: MsgAttachGadgetToHook )
	{
		let gadget = this.m_dispatcher.getGadgetEndpoint( m.grabbableNodeId.endpointId );
		gadget.attachToHook( m.hookNodeId );
	}

	@bind private onDetachGadgetFromHook( env: Envelope, m: MsgDetachGadgetFromHook )
	{
		let gadget = this.m_dispatcher.getGadgetEndpoint( m.grabbableNodeId.endpointId );
		gadget.detachFromHook( m.hookNodeId );
	}

	private attachToHook( hookId: EndpointAddr )
	{
		let hookPath = this.m_dispatcher.getPersistentNodePath( hookId );
		if( !hookPath )
		{
			console.log( `can't attach ${ this.m_id } to `
				+`${ endpointAddrToString( hookId ) } because it doesn't have a path` );
			return;
		}

		persistence.setGadgetHook( this.m_gadgetData.getPersistenceUuid(), hookPath );
	}

	private detachFromHook( hookId: EndpointAddr )
	{
		persistence.setGadgetHook( this.m_gadgetData.getPersistenceUuid(), null );
	}

	@bind private onSaveSettings( env: Envelope, m: MsgSaveSettings )
	{
		if( this.m_gadgetData )
		{
			persistence.setGadgetSettings( this.m_gadgetData.getPersistenceUuid(), m.settings );
		}
	}

	public sendMessage( type: MessageType, msg: any, target: EndpointAddr = undefined, sender:EndpointAddr = undefined  )
	{
		let env: Envelope =
		{
			type,
			sender: sender ? sender : { type: EndpointType.Hub, endpointId: 0 },
			target,
			payload: JSON.stringify( msg ),
		}
		this.sendMessageString( JSON.stringify( env ) )
	}

	public sendMessageString( msgString: string )
	{
		this.m_ws.send( msgString );
	}

	public getName()
	{
		return `#${ this.m_id } (${ EndpointType[ this.m_type ] })`;
	}
	public sendError( error: string, messageType?: MessageType )
	{
		let msg: MsgError =
		{
			error,
			messageType,
		};
		this.sendMessage( MessageType.Error, msg );

		console.log( `sending error to endpoint ${ this.getName() }: ${ error }` );
	}

	public close()
	{
		this.m_ws.close();
	}

	@bind onClose( code: number, reason: string )
	{
		console.log( `connection closed ${ reason }(${ code })` );
		this.m_dispatcher.removeEndpoint( this );

		let lostEpMsg: MsgLostEndpoint =
		{
			endpointId: this.m_id,
		}

		if( this.m_type == EndpointType.Gadget && this.m_gadgetData && this.m_gadgetData.getRoot() )
		{
			// Let renderers know that this gadget is no more.
			this.m_dispatcher.updateGadgetSceneGraph( this.m_id, null, null );
		}

		this.m_dispatcher.sendToAllEndpointsOfType( EndpointType.Monitor,
			{
				sender: { type: EndpointType.Hub },
				type: MessageType.LostEndpoint,
				payloadUnpacked: lostEpMsg,
			} );
		
		this.m_gadgetData = null;
	}
}


class CServer
{
	private m_server = http.createServer( express() );
	private m_wss:WebSocket.Server = null;
	private m_nextEndpointId = 27;
	private m_dispatcher = new CDispatcher;

	constructor( port: number )
	{
		this.m_wss = new WebSocket.Server( { server: this.m_server } );
		this.m_server.listen( port, () => 
		{
			console.log(`Server started on port ${ port } :)`);

			this.m_wss.on('connection', this.onConnection );
		} );
	}

	@bind onConnection( ws: WebSocket )
	{
		this.m_dispatcher.addPendingEndpoint( 
			new CEndpoint( ws, this.m_nextEndpointId++, this.m_dispatcher ) );
	}
}

// the VS Code debugger and the source maps get confused if the CWD is not the workspace dir.
// Instead, just chdir to the data directory if we start in the workspace dir.
let p = process.cwd();
if( path.basename( p ) == "websrc" )
{
	process.chdir( "../data" );
}

let server = new CServer( Number( process.env.PORT ) || 8999 );
